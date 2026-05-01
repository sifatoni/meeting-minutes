import sys

# Force UTF-8 on Windows (default is cp1252, crashes on Bengali/surrogate text).
# Must come before any other import that could trigger I/O.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import json
import os

# Propagate UTF-8 to any child processes (Whisper, etc.)
os.environ["PYTHONIOENCODING"] = "utf-8"
import random
import re
import shutil
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape


FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None

DEFAULT_WHISPER_MODEL = os.environ.get("MEETING_WHISPER_MODEL", "medium")
DEFAULT_OLLAMA_MODEL = os.environ.get("MEETING_OLLAMA_MODEL", "qwen2.5:3b")
CLOUD_MODEL = "google/gemma-3-4b-it:free"
OLLAMA_GENERATE_URL = os.environ.get("MEETING_OLLAMA_URL", "http://127.0.0.1:11434/api/generate")

GROQ_MAX_BYTES = 25 * 1024 * 1024  # Groq's hard per-request file-size limit

# Strings that indicate an error ended up in the transcript - hard-block before LLM
_TRANSCRIPT_ERROR_PATTERNS = [
    "groq api error",
    "request entity too large",
    "not installed",
    "no audio file",
    "[transcription error]",
]


# ─── Transcript Utilities ─────────────────────────────────────────────────────

def clean_text(text):
    """Remove common transcript noise before LLM processing."""
    if not text:
        return ""
    # Strip surrogates and replacement characters that crash UTF-8 serialisation
    text = text.encode("utf-8", "ignore").decode("utf-8")
    text = text.replace("\udc8d", "").replace("�", "")
    # collapse repeated chars
    text = re.sub(r'(.)\1{4,}', r'\1', text)
    # collapse repeated words
    text = re.sub(r'\b(\w+)( \1\b)+', r'\1', text)
    # filler words
    text = re.sub(r'\b(uh+|um+|ah+|hmm+|er+|like|you know)\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(মানে|উম|আচ্ছা|হুম)\b', '', text)
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def is_bad(text):
    if not text or len(text.strip()) < 20:
        return True

    # repeated characters
    if len(set(text)) < 5:
        return True

    # repetitive pattern detection
    words = text.split()
    if len(words) > 10:
        unique_ratio = len(set(words)) / len(words)
        if unique_ratio < 0.3:
            return True

    return False


def load_audio_safe(file_path):
    if not FFMPEG_AVAILABLE:
        sys.stderr.write("[ERROR] ffmpeg not found - cannot process audio\n")
        return None
    try:
        from pydub import AudioSegment
        return AudioSegment.from_file(file_path)
    except ImportError:
        sys.stderr.write("[ERROR] pydub not installed. Run: pip install pydub\n")
        return None
    except Exception as e:
        sys.stderr.write(f"[ERROR] Failed to load audio: {e}\n")
        return None


def split_audio_safe(audio, file_path, chunk_ms=120000):
    if audio is None:
        return []
    chunks = []
    try:
        for i in range(0, len(audio), chunk_ms):
            chunk = audio[i:i + chunk_ms]
            if chunk.dBFS < -42 and len(chunk) > 2000:
                sys.stderr.write(f"[INFO] Skipping silent chunk ({chunk.dBFS:.1f} dBFS)\n")
                continue
            if len(chunk) < 1000:
                continue
            name = f"{file_path}_chunk_{i}.wav"
            chunk.export(name, format="wav")
            chunks.append(name)
    except Exception as e:
        sys.stderr.write(f"[WARN] Chunking failed: {e}\n")
        return [file_path]  # fallback: treat whole file as single chunk
    return chunks


def split_audio(file_path, chunk_ms=120000):
    audio = load_audio_safe(file_path)
    if audio is None:
        return [file_path]  # fallback: pass original file, let transcriber handle it
    return split_audio_safe(audio, file_path, chunk_ms)


def safe_text(text):
    if not isinstance(text, str):
        return ""
    return (
        text.encode("utf-8", "ignore")
        .decode("utf-8", "ignore")
        .replace("\udc8d", "")
        .replace("\x00", "")
    )


# Alias used in new code paths per spec
sanitize_text = safe_text


def deep_sanitize(obj):
    """Recursively sanitize all strings in any JSON-like structure."""
    if isinstance(obj, dict):
        return {k: deep_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [deep_sanitize(i) for i in obj]
    if isinstance(obj, str):
        return sanitize_text(obj)
    return obj


def _safe_str(value):
    """Strip surrogate chars that crash json.dumps, replacing them with '?'."""
    return str(value).encode("utf-8", "replace").decode("utf-8")


def safe_json_dumps(obj, **kwargs):
    """Recursively sanitize all strings then JSON-serialize - never crashes on surrogates."""
    def _clean(v):
        if isinstance(v, str):
            return safe_text(v)
        if isinstance(v, dict):
            return {k: _clean(val) for k, val in v.items()}
        if isinstance(v, list):
            return [_clean(item) for item in v]
        return v
    return json.dumps(_clean(obj), ensure_ascii=False, **kwargs)


def safe_json_print(obj):
    """Recursively sanitize strings in obj then write JSON to stdout.buffer (bypasses TextIOWrapper encoding path)."""
    def _sanitize(v):
        if isinstance(v, str):
            return _safe_str(v)
        if isinstance(v, dict):
            return {k: _sanitize(val) for k, val in v.items()}
        if isinstance(v, list):
            return [_sanitize(item) for item in v]
        return v
    out = json.dumps(_sanitize(obj), ensure_ascii=False)
    sys.stdout.buffer.write(out.encode("utf-8", "ignore") + b"\n")
    sys.stdout.buffer.flush()


def fail_response(reason):
    return {
        "status": "error",
        "message": _safe_str(reason),
        "transcriptPath": None,
        "minutesPath": None,
        "docxPath": None
    }


def detect_language(text):
    bn_chars = sum(1 for c in text if '\u0980' <= c <= '\u09FF')
    en_chars = sum(1 for c in text if c.isascii())

    if bn_chars > en_chars:
        return "bn"
    return "en"


def is_transcript_bad(text):
    if not text or len(text.strip()) < 50:
        return True

    # too repetitive
    words = text.split()
    if len(words) > 20:
        if len(set(words)) / len(words) < 0.25:
            return True

    # too few unique chars
    if len(set(text)) < 10:
        return True

    return False


def transcript_score(text):
    words = text.split()
    if not words:
        return 0

    unique_ratio = len(set(words)) / len(words)
    length_score = min(len(words) / 100, 1)

    return (unique_ratio * 0.7) + (length_score * 0.3)


def is_summary_invalid(summary):
    if not summary or len(summary.strip()) < 80:
        return True

    bad_phrases = [
        "no clear discussion",
        "unable to determine",
        "no meaningful content",
        "could not be identified"
    ]

    for p in bad_phrases:
        if p in summary.lower():
            return True

    return False


def main():
    try:
        _run()
    except Exception as e:
        sys.stderr.write(f"[FATAL] Unhandled exception: {e}\n")
        safe_json_print(fail_response(f"Processing failed: {e}"))
        sys.exit(0)  # exit 0 so JS reads stdout JSON instead of discarding it


def _run():
    payload = json.loads(sys.stdin.read())
    meeting = payload["meeting"]
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    config = payload.get("config", {})

    minutes_path = output_dir / "minutes.json"
    transcript_path = output_dir / "transcript.txt"
    docx_path = get_docx_path(meeting, output_dir)

    _paths = lambda: {
        "transcriptPath": str(transcript_path),
        "minutesPath": str(minutes_path),
        "docxPath": str(docx_path)
    }

    if payload.get("exportOnly"):
        minutes = read_json(minutes_path, {})
        write_docx(docx_path, minutes)
        safe_json_print({"docxPath": str(docx_path)})
        return

    if not FFMPEG_AVAILABLE:
        sys.stderr.write("[WARN] ffmpeg not found in PATH - audio chunking and format conversion unavailable\n")

    transcript_result = transcribe_meeting_audio(meeting, config)

    if not transcript_result.get("success"):
        err_msg = transcript_result.get("error", "Transcription failed.")
        sys.stderr.write(
            f"[ERROR] Transcription failed ({transcript_result.get('type', '?')}): {err_msg}\n"
        )
        transcript_path.write_text(safe_text(f"[TRANSCRIPTION ERROR]\n{err_msg}"), encoding="utf-8", errors="ignore")
        minutes = build_error_minutes(meeting, err_msg)
        minutes_path.write_text(safe_json_dumps(minutes, indent=2), encoding="utf-8", errors="ignore")
        write_docx(docx_path, minutes)
        safe_json_print(_paths())
        return

    transcript_text = transcript_result["text"]

    if is_transcript_bad(transcript_text):
        sys.stderr.write("[GUARD] Transcript failed quality check - blocking before LLM\n")
        minutes = build_error_minutes(meeting, "Transcription corrupted or audio too poor to process.")
        transcript_path.write_text(safe_text(transcript_text or "[empty]"), encoding="utf-8", errors="ignore")
        minutes_path.write_text(safe_json_dumps(minutes, indent=2), encoding="utf-8", errors="ignore")
        write_docx(docx_path, minutes)
        safe_json_print(_paths())
        return

    transcript_text = safe_text(transcript_text)
    transcript_path.write_text(transcript_text, encoding="utf-8", errors="ignore")
    minutes = build_minutes_from_transcript(meeting, transcript_text, config)
    minutes_path.write_text(safe_json_dumps(minutes, indent=2), encoding="utf-8", errors="ignore")
    write_docx(docx_path, minutes)

    safe_json_print(_paths())


def read_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def get_docx_path(meeting, output_dir):
    audio_dir = meeting.get("audioDir")
    if audio_dir and Path(audio_dir).exists():
        return Path(audio_dir) / "meeting_minutes.docx"
    return output_dir / "meeting_minutes.docx"


def transcribe_meeting_audio(meeting, config):
    audio_path = find_meeting_audio(meeting)
    if not audio_path:
        return {"success": False, "error": "No audio file found for this meeting.", "type": "NO_AUDIO"}

    file_size = audio_path.stat().st_size
    needs_chunking = file_size > 20 * 1024 * 1024

    if FFMPEG_AVAILABLE:
        audio_obj = load_audio_safe(str(audio_path))
        if audio_obj is not None and len(audio_obj) > 300000:  # 5 minutes
            needs_chunking = True
    else:
        sys.stderr.write("[WARN] ffmpeg not found - skipping duration check, will attempt transcription directly\n")

    chunks = [str(audio_path)]
    if needs_chunking:
        if not FFMPEG_AVAILABLE:
            sys.stderr.write("[WARN] ffmpeg not found - skipping chunking, passing full file\n")
        else:
            sys.stderr.write("[INFO] Large/long file detected, triggering chunking mode\n")
            chunks = split_audio(str(audio_path), chunk_ms=120000)

    transcription_model = config.get("transcriptionModel", "local")
    return process_audio_chunks(chunks, transcription_model, config, str(audio_path), meeting)


def process_audio_chunks(chunks, transcription_model, config, audio_path, meeting, chunk_ms=120000):
    language = "bn"
    detected_language = False

    whisper_model = None
    try:
        from faster_whisper import WhisperModel
        sys.stderr.write("[INFO] Initializing WhisperModel...\n")
        whisper_model = WhisperModel(DEFAULT_WHISPER_MODEL, device="cpu", compute_type="int8")
    except ImportError:
        sys.stderr.write("[WARN] faster-whisper not installed.\n")

    chunk_texts = []
    good_chunks = 0
    bad_chunks = 0

    for i, chunk_path in enumerate(chunks):
        sys.stderr.write(f"[PROCESSING] chunk {i+1}/{len(chunks)}\n")
        chunk_size = Path(chunk_path).stat().st_size
        if transcription_model == "groq" and chunk_size < GROQ_MAX_BYTES:
            res = transcribe_with_groq_chunk(chunk_path, config, language)
            if not res.get("success"):
                res = transcribe_with_faster_whisper_chunk(chunk_path, whisper_model, language)
        else:
            res = transcribe_with_faster_whisper_chunk(chunk_path, whisper_model, language)

        if not res.get("success"):
            continue

        raw_text = res.get("text", "")
        if not detected_language and raw_text.strip():
            language = detect_language(raw_text)
            detected_language = True
            sys.stderr.write(f"[INFO] Auto-detected language from first chunk: {language}\n")

        chunk_text = clean_text(raw_text)
        if is_bad(chunk_text):
            sys.stderr.write("[SKIPPED] bad chunk\n")
            bad_chunks += 1
            continue

        good_chunks += 1
        chunk_texts.append(chunk_text)

    if not chunk_texts and bad_chunks > 0:
        if chunk_ms > 60000:
            sys.stderr.write("[INFO] All chunks bad, retrying with smaller chunks\n")
            chunks = split_audio(audio_path, chunk_ms=60000)
            return process_audio_chunks(chunks, transcription_model, config, audio_path, meeting, chunk_ms=60000)

    sys.stderr.write(f"[CHUNK] good={good_chunks} bad={bad_chunks}\n")

    if len(chunk_texts) == 0:
        return {
            "success": False,
            "text": "",
            "_status": "failed",
            "_message": "Audio quality too low or silent"
        }

    final_text = " ".join(chunk_texts)
    final_text = clean_text(final_text)

    result = {
        "success": True,
        "text": final_text,
        "_quality": {"good_chunks": good_chunks, "bad_chunks": bad_chunks}
    }

    if good_chunks > 0 and bad_chunks > good_chunks:
        result["_status"] = "partial"
        result["_message"] = "Partial transcript generated due to low audio clarity"

    return result


def transcribe_with_groq_chunk(chunk_path, config, language):
    try:
        from groq import Groq
    except ImportError:
        return {"success": False, "error": "groq package not installed", "type": "IMPORT_ERROR"}
    
    api_key = config.get("groqApiKey", "").strip()
    if not api_key:
        return {"success": False, "error": "Groq API key missing", "type": "NO_API_KEY"}
    
    if language == "bn":
        prompt = "এটি একটি বাংলা ব্যবসায়িক মিটিং। কথাগুলো বাংলা ভাষায় লেখা হবে।"
    else:
        prompt = "This is a business meeting transcript."

    try:
        client = Groq(api_key=api_key)
        with open(chunk_path, "rb") as f:
            transcription = client.audio.transcriptions.create(
                file=(Path(chunk_path).name, f.read()),
                model="whisper-large-v3",
                prompt=prompt,
                response_format="json",
                language=language,
                temperature=0.0
            )
        return {"success": True, "text": transcription.text.strip()}
    except Exception as e:
        return {"success": False, "error": str(e), "type": "GROQ_API_ERROR"}


def transcribe_with_faster_whisper_chunk(chunk_path, model, language):
    if not model:
        return {"success": False, "error": "faster-whisper model not initialized", "type": "IMPORT_ERROR"}

    if language == "bn":
        prompt = (
            "\u098f\u099f\u09bf \u098f\u0995\u099f\u09bf \u09ac\u09be\u0982\u09b2\u09be "
            "\u09ac\u09cd\u09af\u09ac\u09b8\u09be\u09df\u09bf\u0995 \u09ae\u09bf\u099f\u09bf\u0982\u0964 "
            "\u0995\u09a5\u09be\u0997\u09c1\u09b2\u09cb \u09ac\u09be\u0982\u09b2\u09be "
            "\u09ad\u09be\u09b7\u09be\u09df \u09b2\u09c7\u0996\u09be \u09b9\u09ac\u09c7\u0964"
        )
    else:
        prompt = "This is a business meeting transcript."

    try:
        segments, info = model.transcribe(
            str(chunk_path),
            language=language,
            beam_size=1,
            temperature=0,
            condition_on_previous_text=False,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            initial_prompt=prompt,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 700},
        )
        lines = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                lines.append(text)
        return {"success": True, "text": " ".join(lines).strip()}
    except TimeoutError:
        sys.stderr.write("[TIMEOUT] skipping chunk\n")
        return {"success": False, "error": "TimeoutError", "type": "WHISPER_TIMEOUT"}
    except Exception as e:
        return {"success": False, "error": str(e), "type": "WHISPER_ERROR"}


def find_meeting_audio(meeting):
    meeting_audio = meeting.get("files", {}).get("meeting_audio")
    if meeting_audio and Path(meeting_audio).exists():
        return Path(meeting_audio)

    uploaded_audio = meeting.get("files", {}).get("uploaded")
    if uploaded_audio and Path(uploaded_audio).exists():
        return Path(uploaded_audio)

    audio_dir = meeting.get("audioDir")
    if not audio_dir:
        return None

    candidate = Path(audio_dir) / "meeting_audio.webm"
    if candidate.exists():
        return candidate
    return None


def format_timestamp(seconds):
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    remainder = total % 60
    if hours:
        return f"{hours:02d}:{minutes:02d}:{remainder:02d}"
    return f"{minutes:02d}:{remainder:02d}"


def build_demo_minutes(meeting):
    created_at = meeting.get("createdAt") or datetime.now().isoformat()
    date_text = created_at.split("T")[0]

    return {
        "meetingTitle": meeting.get("title", "Untitled Meeting"),
        "client": meeting.get("client", ""),
        "date": date_text,
        "participants": meeting.get("participants", ""),
        "meetingObjective": "Discuss the meeting topics and capture the important outcomes.",
        "discussionSummary": (
            "This is a demo offline meeting-minutes draft. The recording workflow, "
            "local storage, editable minutes, and Word export are working. Replace "
            "the demo processor with offline Bangla transcription and local LLM "
            "summarization for production use."
        ),
        "keyPoints": [
            "The meeting audio was saved in the selected local audio directory.",
            "The app generated a local minutes draft without cloud upload.",
            "The production pipeline should use faster-whisper and a local LLM."
        ],
        "decisions": [
            "Keep meeting data local/private.",
            "Use simple professional English for the final minutes."
        ],
        "actionItems": [
            {
                "task": "Replace demo transcript generation with faster-whisper.",
                "owner": "Developer",
                "deadline": "TBD",
                "notes": "Use small or medium model for low/medium laptops."
            },
            {
                "task": "Add robust Windows system audio capture.",
                "owner": "Developer",
                "deadline": "TBD",
                "notes": "Use WASAPI loopback for Google Meet headset scenarios."
            }
        ],
        "risks": [
            "System audio capture must be tested carefully with headset users.",
            "Long meetings may process slowly on low-end laptops."
        ],
        "nextSteps": [
            "Run this MVP in VSCode.",
            "Validate the recording flow.",
            "Implement the real offline AI pipeline."
        ]
    }


def build_error_minutes(meeting, message):
    created_at = meeting.get("createdAt") or datetime.now().isoformat()
    return {
        "meetingTitle": meeting.get("title", "Untitled Meeting"),
        "client": meeting.get("client", ""),
        "date": created_at.split("T")[0],
        "participants": meeting.get("participants", ""),
        "meetingObjective": "Transcription failed - minutes could not be generated.",
        "discussionSummary": str(message),
        "keyPoints": [],
        "decisions": [],
        "actionItems": [],
        "risks": ["Transcription failed - meeting minutes cannot be generated from this recording."],
        "nextSteps": [
            "Check your Groq API key and audio file size (Groq max: 25 MB).",
            "Switch to 'Local (faster-whisper)' transcription in the sidebar.",
            "Re-record or upload a shorter clip, then click Generate Minutes again."
        ],
        "_transcriptionError": True
    }


def build_minutes_from_transcript(meeting, transcript_result, config):
    # Hard guard: reject error dicts that somehow reached this function
    if isinstance(transcript_result, dict):
        is_success = transcript_result.get("success")
        if is_success is False or transcript_result.get("_status") == "failed":
            error_msg = transcript_result.get("_message") or transcript_result.get("error", "Transcription failed.")
            return build_error_minutes(meeting, error_msg)
        transcript = transcript_result.get("text", "")
        quality = transcript_result.get("_quality", {"good_chunks": 0, "bad_chunks": 0})
    else:
        transcript = transcript_result
        quality = {"good_chunks": 1, "bad_chunks": 0}

    # Hard guard: reject known error-string patterns before they reach the LLM
    transcript_lower = (transcript or "").lower()
    for pattern in _TRANSCRIPT_ERROR_PATTERNS:
        if pattern in transcript_lower:
            sys.stderr.write(f"[GUARD] Blocking bad transcript - matched pattern: {pattern!r}\n")
            return build_error_minutes(meeting, transcript[:500])

    created_at = meeting.get("createdAt") or datetime.now().isoformat()
    date_text = created_at.split("T")[0]
    transcript_body = strip_transcript_metadata(transcript)

    # Clean noise
    transcript_body = clean_text(transcript_body)
    
    sys.stderr.write(f"[FINAL CHECK] length={len(transcript_body)} unique_words={len(set(transcript_body.split()))}\n")
    
    score = transcript_score(transcript_body)
    confidence = round(score * 100)
    sys.stderr.write(f"[QUALITY] score={score:.2f} confidence={confidence}%\n")
    if score < 0.4:
        return build_error_minutes(meeting, "Audio quality too low. Cannot generate reliable meeting minutes.")

    if is_transcript_bad(transcript_body):
        return build_error_minutes(meeting, "Transcript appears corrupted or repetitive.")

    if len(transcript_body.split()) < 30:
        return build_error_minutes(meeting, "Not enough speech detected.")
    
    if not transcript_body:
        sys.stderr.write("[INFO] Transcript completely empty after cleaning.\n")

    llm_minutes = generate_minutes(meeting, date_text, transcript_body, config)
    if llm_minutes:
        llm_minutes["_confidence"] = confidence

        if is_summary_invalid(llm_minutes.get("discussionSummary", "")):
            return build_error_minutes(meeting, "Could not generate reliable meeting minutes from this audio.")
        if isinstance(transcript_result, dict) and transcript_result.get("_status") == "partial":
            llm_minutes["_statusMessage"] = transcript_result.get("_message", "Low audio clarity - partial insights generated")
            sys.stderr.write(f"[INFO] Status Message injected: {llm_minutes['_statusMessage']}\n")
        elif quality.get("bad_chunks", 0) > quality.get("good_chunks", 0):
            llm_minutes["_statusMessage"] = "Low audio clarity - partial insights generated"
            sys.stderr.write("[INFO] Status Message injected: Low audio clarity\n")
        return llm_minutes

    return {
        "meetingTitle": meeting.get("title", "Untitled Meeting"),
        "client": meeting.get("client", ""),
        "date": date_text,
        "participants": meeting.get("participants", ""),
        "meetingObjective": "Could not generate structured minutes - AI model is not available.",
        "discussionSummary": (
            "The audio was transcribed successfully, but the AI model (Ollama) is not running on this computer. "
            "The app needs Ollama to convert the transcript into structured meeting minutes.\n\n"
            "To fix this:\n"
            "1. Open the app - the AI Setup panel should appear and install Ollama automatically.\n"
            "2. Or install Ollama manually from https://ollama.com\n"
            "3. After installing, run: ollama pull " + (config.get("model") or DEFAULT_OLLAMA_MODEL) + "\n"
            "4. Then click Generate Minutes again."
        ),
        "keyPoints": [
            "Audio transcription completed successfully.",
            "AI model (Ollama) is not installed or running - structured minutes cannot be generated yet."
        ],
        "decisions": [],
        "actionItems": [
            {
                "task": "Install Ollama and the required AI model.",
                "owner": "User",
                "deadline": "Before generating minutes",
                "notes": "The app will try to install Ollama automatically on next launch. Or visit https://ollama.com"
            }
        ],
        "risks": [],
        "nextSteps": [
            "Restart the app to trigger automatic Ollama installation.",
            "Or install Ollama manually and run: ollama pull " + (config.get("model") or DEFAULT_OLLAMA_MODEL),
            "Click Generate Minutes again after Ollama is ready."
        ],
        "transcript": transcript_body
    }


def generate_minutes(meeting, date_text, transcript, config):
    transcript = clean_text(transcript)
    if not transcript.strip():
        return None

    sys.stderr.write(f"[SUMMARY INPUT LENGTH]: {len(transcript)}\n")
    summary_mode = config.get("summaryMode", "standard")
    lang = detect_language(transcript)
    sys.stderr.write(f"[INFO] Detected language: {lang.upper()} | Summary mode: {summary_mode}\n")

    prompt = build_minutes_prompt(meeting, date_text, transcript, summary_mode, lang)
    model = config.get("model", "")

    if model == "online":
        result = generate_minutes_with_openrouter(meeting, date_text, transcript, config, prompt)
        if result is not None:
            return result
        sys.stderr.write("[FALLBACK] OpenRouter failed - falling back to local Ollama\n")

    ollama_result = generate_minutes_with_ollama(meeting, date_text, transcript, config, prompt)
    if ollama_result is not None:
        return ollama_result

    sys.stderr.write("[FALLBACK] Ollama failed - using simple text extraction fallback\n")
    return simple_summary_fallback(meeting, date_text, transcript)


def simple_summary_fallback(meeting, date_text, transcript):
    """Last-resort fallback: extract structure directly from transcript text - no AI required."""
    sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', transcript) if len(s.strip()) > 20]
    key_points = sentences[:5] if sentences else [transcript[:200]]

    return {
        "meetingTitle": meeting.get("title", "Untitled Meeting"),
        "client": meeting.get("client", ""),
        "date": date_text,
        "participants": meeting.get("participants", ""),
        "meetingObjective": "General discussion",
        "discussionSummary": "The meeting included multiple discussion points but AI services failed. A fallback summary has been generated.",
        "keyPoints": key_points if key_points else ["General discussion took place"],
        "decisions": [],
        "actionItems": [],
        "risks": [],
        "nextSteps": ["Review this auto-extracted summary and edit as needed."],
        "transcript": transcript,
        "_statusMessage": "AI model unavailable - this is an auto-extracted summary only.",
        "_confidence": 0
    }


def generate_minutes_with_openrouter(meeting, date_text, transcript, config, prompt):
    api_key = config.get("openRouterApiKey", "").strip()
    if not api_key:
        sys.stderr.write("[OPENROUTER] No API key provided\n")
        return None

    payload = json.dumps({
        "model": CLOUD_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a professional meeting analyst. "
                    "Generate structured meeting minutes from the transcript. "
                    "Rules: Discussion Summary MUST be at least 120 words. "
                    "Key points MUST have at least 5 items. "
                    "No empty fields allowed - infer intelligently if unclear. "
                    "Output ONLY valid JSON, no markdown, no explanation."
                )
            },
            {"role": "user", "content": sanitize_text(prompt)}
        ],
        "temperature": 0.3
    }).encode("utf-8")

    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        },
        method="POST"
    )

    result = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=120) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            break  # success
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 402, 429):
                sys.stderr.write(f"[OPENROUTER] {e.code} - OpenRouter unusable -> fallback instantly\n")
                return None
            sys.stderr.write(f"[OPENROUTER] HTTP {e.code}: {e.reason}\n")
            return None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            wait = 2 * (attempt + 1) + random.uniform(0, 1)
            sys.stderr.write(f"[OPENROUTER] Network error (attempt {attempt + 1}/2): {e} - retry in {wait:.1f}s\n")
            if attempt < 1:
                time.sleep(wait)
                continue
            return None

    if result is None:
        sys.stderr.write("[OPENROUTER] Failed after 2 attempts\n")
        return None

    try:
        raw_response = result["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError) as e:
        sys.stderr.write(f"[OPENROUTER] Unexpected response shape: {e}\n")
        return None

    # Sanitize before any further processing - surrogates crash json.loads
    raw_response = clean_text(raw_response)
    sys.stderr.write(f"[OPENROUTER] Response length: {len(raw_response)} chars\n")

    # Strip <think> blocks (some models emit them)
    raw_response = re.sub(r'<think>.*?</think>', '', raw_response, flags=re.DOTALL).strip()

    # Unwrap markdown code fences if present
    match = re.search(r'```(?:json)?\s*(.*?)```', raw_response, re.DOTALL)
    if match:
        raw_response = match.group(1).strip()

    if not raw_response.startswith('{'):
        json_match = re.search(r'\{.*\}', raw_response, re.DOTALL)
        if json_match:
            raw_response = json_match.group(0)

    try:
        minutes = json.loads(sanitize_text(raw_response))
        minutes = deep_sanitize(minutes)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[OPENROUTER] JSON decode failed: {e} - using raw text as summary\n")
        minutes = {"discussionSummary": sanitize_text(raw_response[:1000]), "keyPoints": [], "actionItems": []}

    return normalize_llm_minutes(minutes, meeting, date_text, transcript)


def is_ollama_running():
    try:
        urllib.request.urlopen(
            OLLAMA_GENERATE_URL.replace("/api/generate", ""),
            timeout=2
        )
        return True
    except Exception:
        return False


def generate_minutes_with_ollama(meeting, date_text, transcript, config, prompt):
    model_name = config.get("model", "")
    if not model_name or model_name == "online":
        model_name = DEFAULT_OLLAMA_MODEL

    sys.stderr.write(f"[DEBUG] Ollama: using model '{model_name}'\n")
    sys.stderr.write(f"[DEBUG] Ollama: transcript length = {len(transcript)} chars\n")

    if not is_ollama_running():
        sys.stderr.write("[DEBUG] Ollama is not reachable - skipping\n")
        return None

    # Use the chat API with /no_think to prevent qwen3.5 thinking mode
    # which causes empty responses with format:json or timeouts without it
    payload = {
        "model": model_name,
        "messages": [
            {
                "role": "system",
                "content": (
                    "/no_think You are a professional meeting analyst. "
                    "Analyze the transcript and generate structured meeting minutes. "
                    "Rules: "
                    "- Discussion Summary MUST be at least 120 words. "
                    "- Key points MUST have at least 5 bullet points. "
                    "- Do NOT return empty fields. "
                    "- If data unclear, infer intelligently from context. "
                    "Output ONLY valid JSON, no markdown, no explanation."
                )
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0.1,
            "num_ctx": 8192
        }
    }

    ollama_chat_url = OLLAMA_GENERATE_URL.replace("/api/generate", "/api/chat")

    try:
        request = urllib.request.Request(
            ollama_chat_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(request, timeout=600) as response:
            result = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        sys.stderr.write(f"[DEBUG] Ollama network/parse error: {e}\n")
        return None

    raw_response = ""
    msg = result.get("message", {})
    if msg:
        raw_response = msg.get("content", "").strip()

    # Sanitize before any further processing - surrogates crash json.loads
    raw_response = clean_text(raw_response)
    sys.stderr.write(f"[DEBUG] Ollama raw_response length = {len(raw_response)}\n")
    sys.stderr.write(f"[DEBUG] Ollama raw_response first 500 chars: {raw_response[:500]}\n")

    if not raw_response:
        sys.stderr.write("[DEBUG] Ollama returned EMPTY response\n")
        return None

    # Strip <think>...</think> blocks just in case
    raw_response = re.sub(r'<think>.*?</think>', '', raw_response, flags=re.DOTALL).strip()

    # Extract JSON from markdown code fences if present
    match = re.search(r'```(?:json)?\s*(.*?)```', raw_response, re.DOTALL)
    if match:
        raw_response = match.group(1).strip()

    # Try to find a JSON object directly
    if not raw_response.startswith('{'):
        json_match = re.search(r'\{.*\}', raw_response, re.DOTALL)
        if json_match:
            raw_response = json_match.group(0)

    try:
        minutes = json.loads(sanitize_text(raw_response))
        minutes = deep_sanitize(minutes)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[DEBUG] JSON decode error: {e} - using raw text as summary\n")
        minutes = {"discussionSummary": sanitize_text(raw_response[:1000]), "keyPoints": [], "actionItems": []}

    return normalize_llm_minutes(minutes, meeting, date_text, transcript)


def build_minutes_prompt(meeting, date_text, transcript, summary_mode="standard", lang="bn"):
    transcript_for_prompt = transcript[:24000]

    if summary_mode == "short":
        mode_rule = "Keep discussionSummary to 3–4 sentences. Limit keyPoints to 5 bullets maximum."
    elif summary_mode == "detailed":
        mode_rule = "Be thorough and detailed in all fields. Provide full context and nuance."
    else:
        mode_rule = "Provide clear, professional, balanced minutes."

    transcript_label = "বাংলা transcript (Bengali audio)" if lang == "bn" else "Transcript"

    return f"""You are an expert precision note-taker.

STRICT RULES:
1. The transcript may be in Bangla, English, or a mix. Output must be in English.
2. CRITICAL: DO NOT invent facts, departments (like HR), or corporate terms unless explicitly spoken in the audio.
3. If the audio is a YouTube video, podcast, or casual talk, summarize its ACTUAL content. Do not pretend it is a workplace meeting.
4. Return empty arrays `[]` for decisions, actionItems, risks, or nextSteps if none exist in the text.
5. DO NOT hallucinate owners or deadlines. Use "None" or empty list `[]`.
6. {mode_rule}

Return only valid JSON using this exact shape:
{{
  "meetingObjective": "string",
  "discussionSummary": "string",
  "keyPoints": ["string"],
  "decisions": ["string"],
  "actionItems": [
    {{
      "task": "string",
      "owner": "string",
      "deadline": "string",
      "notes": "string"
    }}
  ],
  "risks": ["string"],
  "nextSteps": ["string"]
}}

Meeting metadata:
Title: {meeting.get("title", "Untitled Meeting")}
Client / Company: {meeting.get("client", "")}
Date: {date_text}
Participants: {meeting.get("participants", "")}

{transcript_label}:
{transcript_for_prompt}""".strip()


def normalize_llm_minutes(minutes, meeting, date_text, transcript):
    return {
        "meetingTitle": meeting.get("title", "Untitled Meeting"),
        "client": meeting.get("client", ""),
        "date": date_text,
        "participants": meeting.get("participants", ""),
        "meetingObjective": normalize_text(minutes.get("meetingObjective"), "Not clearly discussed."),
        "discussionSummary": normalize_text(minutes.get("discussionSummary"), "Not clearly discussed."),
        "keyPoints": normalize_list(minutes.get("keyPoints")),
        "decisions": normalize_list(minutes.get("decisions")),
        "actionItems": normalize_action_items(minutes.get("actionItems")),
        "risks": normalize_list(minutes.get("risks")),
        "nextSteps": normalize_list(minutes.get("nextSteps")),
        "transcript": transcript
    }


def normalize_text(value, fallback):
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback


def normalize_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def normalize_action_items(value):
    if not isinstance(value, list):
        return []

    action_items = []
    for item in value:
        if isinstance(item, dict):
            task = str(item.get("task", "")).strip()
            if not task:
                continue
            action_items.append({
                "task": task,
                "owner": str(item.get("owner", "TBD")).strip() or "TBD",
                "deadline": str(item.get("deadline", "TBD")).strip() or "TBD",
                "notes": str(item.get("notes", "")).strip()
            })
        elif str(item).strip():
            action_items.append({
                "task": str(item).strip(),
                "owner": "TBD",
                "deadline": "TBD",
                "notes": ""
            })
    return action_items


def strip_transcript_metadata(transcript):
    lines = []
    for line in transcript.splitlines():
        if line.startswith("Transcription language:"):
            continue
        if line.startswith("Language probability:"):
            continue
        if line.startswith("Model:"):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def write_docx(path, minutes):
    paragraphs = minutes_to_paragraphs(minutes)
    document_xml = build_document_xml(paragraphs)

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as docx:
        docx.writestr("[Content_Types].xml", content_types_xml())
        docx.writestr("_rels/.rels", rels_xml())
        docx.writestr("word/_rels/document.xml.rels", document_rels_xml())
        docx.writestr("word/document.xml", document_xml)


def minutes_to_paragraphs(minutes):
    if "rawText" in minutes:
        return [{"text": line, "heading": line.strip() in {
            "Meeting Minutes",
            "Meeting Objective:",
            "Discussion Summary:",
            "Key Points Discussed:",
            "Decisions Made:",
            "Action Items:",
            "Risks / Concerns:",
            "Next Steps:"
        }} for line in minutes["rawText"].splitlines()]

    rows = [
        {"text": "Meeting Minutes", "heading": True},
        {"text": f"Meeting Title: {minutes.get('meetingTitle', '')}"},
        {"text": f"Client / Company: {minutes.get('client', '')}"},
        {"text": f"Date: {minutes.get('date', '')}"},
        {"text": f"Participants: {minutes.get('participants', '')}"},
        {"text": ""},
        {"text": "Meeting Objective:", "heading": True},
        {"text": minutes.get("meetingObjective", "")},
        {"text": ""},
        {"text": "Discussion Summary:", "heading": True},
        {"text": minutes.get("discussionSummary", "")},
        {"text": ""},
        {"text": "Key Points Discussed:", "heading": True},
    ]

    rows.extend(bullets(minutes.get("keyPoints", [])))
    rows.append({"text": "Decisions Made:", "heading": True})
    rows.extend(bullets(minutes.get("decisions", [])))
    rows.append({"text": "Action Items:", "heading": True})

    action_items = minutes.get("actionItems", [])
    if action_items:
        for item in action_items:
            rows.append({"text": f"- {item.get('task', '')} | Owner: {item.get('owner', 'TBD')} | Deadline: {item.get('deadline', 'TBD')} | Notes: {item.get('notes', '')}"})
    else:
        rows.append({"text": "- No action items identified."})

    rows.append({"text": "Risks / Concerns:", "heading": True})
    rows.extend(bullets(minutes.get("risks", [])))
    rows.append({"text": "Next Steps:", "heading": True})
    rows.extend(bullets(minutes.get("nextSteps", [])))
    return rows


def bullets(items):
    if not items:
        return [{"text": "- None identified."}]
    return [{"text": f"- {item}"} for item in items]


def build_document_xml(paragraphs):
    body = []
    for paragraph in paragraphs:
        text = escape(paragraph.get("text", ""))
        if paragraph.get("heading"):
            body.append(
                f"<w:p><w:r><w:rPr><w:b/><w:sz w:val=\"28\"/></w:rPr><w:t>{text}</w:t></w:r></w:p>"
            )
        else:
            body.append(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")

    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
        f"<w:body>{''.join(body)}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>"
        "<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/>"
        "</w:sectPr></w:body></w:document>"
    )


def content_types_xml():
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
        "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
        "</Types>"
    )


def rels_xml():
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
        "</Relationships>"
    )


def document_rels_xml():
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>"
    )


if __name__ == "__main__":
    main()
