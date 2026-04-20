# Offline Meeting Minutes Generator

Windows desktop MVP starter for recording Bangla meetings and generating simple professional English meeting minutes locally.

## What This Version Does

- English desktop UI
- Mandatory audio save directory selection
- New meeting form
- Microphone recording
- Optional system audio capture using screen/system capture permission
- Saves audio files locally in the selected directory
- Transcribes `meeting_audio.webm` locally with `faster-whisper`
- Generates English meeting minutes locally with Ollama when available
- Falls back to a transcript-based draft if Ollama is not ready
- Exports a `.docx` Word file without using cloud APIs

## Important

This is an MVP starter, not the final production app.

The current processing pipeline is local. It can transcribe Bangla meeting audio with `faster-whisper`, then generate simple professional English meeting minutes through a local Ollama model.

- Ollama or llama.cpp for offline English meeting minutes generation
- Windows WASAPI loopback recorder for more reliable Google Meet system audio capture

## Requirements

- Windows 10 or Windows 11
- Node.js 20+
- Python 3.11+
- Ollama for local English meeting-minutes generation
- Internet only for first dependency/model download

## How To Run

Open this folder in VSCode, then run:

```powershell
npm install
python -m pip install -r requirements.txt
npm start
```

If `npm install` or `pip install` is blocked by network settings, run it again when you have internet access.

The first time you click `Generate Minutes`, `faster-whisper` may download the selected speech-to-text model. After the model is downloaded, transcription can run offline.

By default the app uses the `medium` Whisper model because the `small` model often produces poor Bangla transcription. It is slower, but more reliable for real Bangla meetings.

To use a smaller model for testing:

```powershell
$env:MEETING_WHISPER_MODEL="small"
npm start
```

## Local LLM Setup

Install Ollama from:

```text
https://ollama.com
```

Then open PowerShell and run:

```powershell
ollama pull qwen2.5:3b
```

Keep Ollama running while using `Generate Minutes`. The app calls the local Ollama server at:

```text
http://127.0.0.1:11434
```

Default model:

```text
qwen2.5:3b
```

To try a stronger but slower model:

```powershell
$env:MEETING_OLLAMA_MODEL="qwen2.5:7b"
npm start
```

## How To Use

1. Open the app.
2. Click `Choose Audio Folder`.
3. Create a new meeting.
4. Click `Start Recording`.
5. Allow microphone access.
6. For Google Meet audio, keep `Try to capture system audio for Google Meet` enabled.
7. Ask the other participant to speak for a few seconds after pressing `Start Recording`.
8. Confirm the app shows `System audio: recording`.
9. Click `Stop Recording`.
10. Click `Generate Minutes`.
11. Edit the generated minutes.
12. Click `Export Word`.

The Word file is saved in the same selected meeting folder as `meeting_audio.webm`:

```text
meeting_minutes.docx
```

## Google Meet Headset Audio

If you use a headset, your microphone records only your own voice. The other participant comes through Windows system audio, so system audio capture must be active.

This MVP now asks Electron to capture Windows loopback audio. If the app shows `System audio: not saved`, do not use that recording for important minutes. Test again with Google Meet audio playing.

When recording works, the selected meeting folder should contain:

- `meeting_audio.webm` - combined audio for transcription

The app records temporary mic/system tracks while the meeting is running, then permanently deletes `mic.webm` and `system.webm` after `meeting_audio.webm` is saved successfully. If combined audio fails, the source tracks may remain for debugging.

For a production build, replace this browser/Electron capture path with a dedicated Windows WASAPI loopback recorder for the most reliable result.

## Project Structure

```text
src/
  main/
    main.js       Electron main process and file operations
    preload.js    Safe API exposed to the UI
  renderer/
    index.html    App screen
    app.css       UI styles
    app.js        UI and recording workflow
scripts/
  process_meeting.py  Local processing placeholder
docs/
  VIBE_CODING_PROMPT.md
```

## Next Development Step

Ask your AI coding tool to follow `docs/VIBE_CODING_PROMPT.md`. That prompt explains how to turn this starter into the full offline production application.
