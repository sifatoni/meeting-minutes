import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape


DEFAULT_WHISPER_MODEL = os.environ.get("MEETING_WHISPER_MODEL", "medium")
DEFAULT_OLLAMA_MODEL = os.environ.get("MEETING_OLLAMA_MODEL", "gemini-3-flash-preview")
OLLAMA_GENERATE_URL = os.environ.get("MEETING_OLLAMA_URL", "http://127.0.0.1:11434/api/generate")


def main():
    payload = json.loads(sys.stdin.read())
    meeting = payload["meeting"]
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    config = payload.get("config", {})

    minutes_path = output_dir / "minutes.json"
    transcript_path = output_dir / "transcript.txt"
    docx_path = get_docx_path(meeting, output_dir)

    if payload.get("exportOnly"):
        minutes = read_json(minutes_path, {})
        write_docx(docx_path, minutes)
        print(json.dumps({"docxPath": str(docx_path)}))
        return

    transcript = transcribe_meeting_audio(meeting, config)
    transcript_path.write_text(transcript, encoding="utf-8")

    minutes = build_minutes_from_transcript(meeting, transcript, config)
    minutes_path.write_text(json.dumps(minutes, indent=2), encoding="utf-8")
    write_docx(docx_path, minutes)

    print(json.dumps({
        "transcriptPath": str(transcript_path),
        "minutesPath": str(minutes_path),
        "docxPath": str(docx_path)
    }))


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
    transcription_model = config.get("transcriptionModel", "local")
    
    if transcription_model == "groq":
        return transcribe_with_groq(meeting, config)
    else:
        return transcribe_with_faster_whisper(meeting)


def transcribe_with_groq(meeting, config):
    audio_path = find_meeting_audio(meeting)
    if not audio_path:
        return (
            "No audio file could be found for this meeting.\n\n"
            "Record a meeting or upload an audio file first, then click Generate Minutes again."
        )

    try:
        from groq import Groq
    except ImportError:
        return (
            "groq is not installed yet.\n\n"
            "Run this command in the project folder:\n"
            "python -m pip install -r requirements.txt\n\n"
            f"Audio waiting for transcription:\n{audio_path}"
        )

    api_key = config.get("groqApiKey", "").strip()
    if not api_key:
        return "Groq API key is missing. Please enter it in the Transcription model settings in the sidebar."

    try:
        client = Groq(api_key=api_key)
        
        with open(audio_path, "rb") as file:
            transcription = client.audio.transcriptions.create(
                file=(audio_path.name, file.read()),
                model="whisper-large-v3",
                prompt="এটি একটি বাংলা ব্যবসায়িক মিটিং। কথাগুলো বাংলা ভাষায় লেখা হবে।",
                response_format="json",
                language="bn",
                temperature=0.0
            )
            
        lines = [
            f"Transcription language: Bengali (Groq Whisper Large V3)",
            f"Model: whisper-large-v3",
            "",
            transcription.text
        ]
        return "\n".join(lines).strip()
    except Exception as e:
        return f"Groq API Error: {str(e)}\n\nFallback to local transcription is recommended if error persists."


def transcribe_with_faster_whisper(meeting):
    audio_path = find_meeting_audio(meeting)
    if not audio_path:
        return (
            "No audio file could be found for this meeting.\n\n"
            "Record a meeting or upload an audio file first, then click Generate Minutes again."
        )

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return (
            "faster-whisper is not installed yet.\n\n"
            "Run this command in the project folder:\n"
            "python -m pip install -r requirements.txt\n\n"
            f"Audio waiting for transcription:\n{audio_path}"
        )

    model = WhisperModel(DEFAULT_WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        language="bn",
        beam_size=5,
        temperature=0,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        initial_prompt=(
            "\u098f\u099f\u09bf \u098f\u0995\u099f\u09bf \u09ac\u09be\u0982\u09b2\u09be "
            "\u09ac\u09cd\u09af\u09ac\u09b8\u09be\u09df\u09bf\u0995 \u09ae\u09bf\u099f\u09bf\u0982\u0964 "
            "\u0995\u09a5\u09be\u0997\u09c1\u09b2\u09cb \u09ac\u09be\u0982\u09b2\u09be "
            "\u09ad\u09be\u09b7\u09be\u09df \u09b2\u09c7\u0996\u09be \u09b9\u09ac\u09c7\u0964"
        ),
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 700},
    )

    lines = [
        f"Transcription language: {info.language}",
        f"Language probability: {info.language_probability:.2f}",
        f"Model: faster-whisper {DEFAULT_WHISPER_MODEL}",
        "",
    ]

    for segment in segments:
        start = format_timestamp(segment.start)
        end = format_timestamp(segment.end)
        text = segment.text.strip()
        if text:
            lines.append(f"[{start} - {end}] {text}")

    return "\n".join(lines).strip()


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


def build_minutes_from_transcript(meeting, transcript, config):
    if "faster-whisper is not installed" in transcript or "No audio file could be found" in transcript or "No meeting_audio.webm" in transcript:
        return {
            "meetingTitle": meeting.get("title", "Untitled Meeting"),
            "client": meeting.get("client", ""),
            "date": (meeting.get("createdAt") or datetime.now().isoformat()).split("T")[0],
            "participants": meeting.get("participants", ""),
            "meetingObjective": "Transcription could not be completed.",
            "discussionSummary": transcript,
            "keyPoints": [
                "The recording step may be complete, but transcription could not run yet."
            ],
            "decisions": [],
            "actionItems": [
                {
                    "task": "Install or repair faster-whisper dependencies.",
                    "owner": "User",
                    "deadline": "Before the next transcription test",
                    "notes": "Run python -m pip install -r requirements.txt"
                }
            ],
            "risks": [
                "Meeting minutes cannot be generated until transcription works."
            ],
            "nextSteps": [
                "Fix the transcription setup and generate minutes again."
            ]
        }

    created_at = meeting.get("createdAt") or datetime.now().isoformat()
    date_text = created_at.split("T")[0]
    transcript_body = strip_transcript_metadata(transcript)
    llm_minutes = generate_minutes(meeting, date_text, transcript_body, config)
    if llm_minutes:
        return llm_minutes

    return {
        "meetingTitle": meeting.get("title", "Untitled Meeting"),
        "client": meeting.get("client", ""),
        "date": date_text,
        "participants": meeting.get("participants", ""),
        "meetingObjective": "Could not generate structured minutes — AI model is not available.",
        "discussionSummary": (
            "The audio was transcribed successfully, but the AI model (Ollama) is not running on this computer. "
            "The app needs Ollama to convert the transcript into structured meeting minutes.\n\n"
            "To fix this:\n"
            "1. Open the app — the AI Setup panel should appear and install Ollama automatically.\n"
            "2. Or install Ollama manually from https://ollama.com\n"
            "3. After installing, run: ollama pull " + (config.get("model") or DEFAULT_OLLAMA_MODEL) + "\n"
            "4. Then click Generate Minutes again."
        ),
        "keyPoints": [
            "Audio transcription completed successfully.",
            "AI model (Ollama) is not installed or running — structured minutes cannot be generated yet."
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
    if not transcript.strip():
        return None

    prompt = build_minutes_prompt(meeting, date_text, transcript)
    model = config.get("model", "")

    if model == "online":
        return generate_minutes_with_openrouter(meeting, date_text, transcript, config, prompt)
    else:
        return generate_minutes_with_ollama(meeting, date_text, transcript, config, prompt)


def generate_minutes_with_openrouter(meeting, date_text, transcript, config, prompt):
    try:
        from openrouter import OpenRouter
    except ImportError:
        return None

    api_key = config.get("openRouterApiKey", "")
    if not api_key:
        return None

    try:
        with OpenRouter(api_key=api_key) as client:
            response = client.chat.send(
                model="qwen/qwen3-next-80b-a3b-instruct:free",
                messages=[
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            )
            raw_response = response.choices[0].message.content
            
            try:
                import re
                match = re.search(r'```(?:json)?(.*?)```', raw_response, re.DOTALL)
                if match:
                    raw_response = match.group(1)
                minutes = json.loads(raw_response.strip())
            except json.JSONDecodeError:
                return None
                
            return normalize_llm_minutes(minutes, meeting, date_text, transcript)
    except Exception:
        return None


def generate_minutes_with_ollama(meeting, date_text, transcript, config, prompt):
    model_name = config.get("model", "")
    if not model_name or model_name == "online":
        model_name = DEFAULT_OLLAMA_MODEL

    sys.stderr.write(f"[DEBUG] Ollama: using model '{model_name}'\n")
    sys.stderr.write(f"[DEBUG] Ollama: transcript length = {len(transcript)} chars\n")

    # First check if Ollama is reachable
    try:
        check_req = urllib.request.Request(
            OLLAMA_GENERATE_URL.replace("/api/generate", ""),
            method="GET"
        )
        urllib.request.urlopen(check_req, timeout=5)
    except (urllib.error.URLError, OSError) as e:
        sys.stderr.write(f"[DEBUG] Ollama is not reachable: {e}\n")
        return None

    # Use the chat API with /no_think to prevent qwen3.5 thinking mode
    # which causes empty responses with format:json or timeouts without it
    payload = {
        "model": model_name,
        "messages": [
            {
                "role": "system",
                "content": "/no_think You are a JSON-only meeting minutes generator. Output ONLY valid JSON, no markdown, no explanation."
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
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        sys.stderr.write(f"[DEBUG] Ollama network/parse error: {e}\n")
        return None

    raw_response = ""
    msg = result.get("message", {})
    if msg:
        raw_response = msg.get("content", "").strip()

    sys.stderr.write(f"[DEBUG] Ollama raw_response length = {len(raw_response)}\n")
    sys.stderr.write(f"[DEBUG] Ollama raw_response first 500 chars: {raw_response[:500]}\n")

    if not raw_response:
        sys.stderr.write("[DEBUG] Ollama returned EMPTY response\n")
        return None

    import re
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
        minutes = json.loads(raw_response)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[DEBUG] JSON decode error: {e}\n")
        sys.stderr.write(f"[DEBUG] Attempted to parse: {raw_response[:500]}\n")
        return None

    return normalize_llm_minutes(minutes, meeting, date_text, transcript)


def build_minutes_prompt(meeting, date_text, transcript):
    transcript_for_prompt = transcript[:24000]
    return f"""
You are an expert precision note-taker.

STRICT RULES:
1. The transcript may be in Bangla, English, or a mix. Output must be in English.
2. CRITICAL: DO NOT invent facts, departments (like HR), or corporate terms unless they are explicitly spoken in the audio.
3. If the audio is a YouTube video, podcast, or casual talk, summarize its ACTUAL content. Do not pretend it is a workplace meeting.
4. It is perfectly fine and EXPECTED to return empty arrays `[]` for decisions, actionItems, risks, or nextSteps if they do not exist in the text.
5. DO NOT hallucinate owners or deadlines to fill the JSON. Leave them as "None" or use an empty list `[]`.

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

Bangla transcript:
{transcript_for_prompt}
""".strip()


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
