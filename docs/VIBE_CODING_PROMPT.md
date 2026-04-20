# Vibe Coding Prompt

You are a senior desktop application engineer. Build a production-ready Windows 10/11 desktop app from this existing MVP starter project.

## Product Goal

Create a fully offline meeting recorder and minutes generator for software company and corporate team meetings.

The app must:

- Run on Windows 10 and Windows 11.
- Use English UI.
- Record Bangla meetings from Google Meet or offline meetings.
- Use a manual record button.
- Support headset users by capturing both microphone audio and system audio.
- Save meeting audio in a user-selected mandatory directory.
- Work without network after first-time model download.
- Transcribe Bangla speech offline.
- Generate simple professional English meeting minutes offline.
- Allow editing generated minutes.
- Export meeting minutes as a Word `.docx` file.
- Keep all meeting data local/private.

## Locked MVP Requirements

- Platform: Windows desktop.
- UI language: English.
- Meeting language: Bangla.
- Output language: English.
- Output style: simple professional English.
- Recording: manual start/stop.
- Audio sources: microphone plus system audio.
- Speaker identification: not required.
- Transcript editing: not required.
- Minutes editing: required.
- Export: Word `.docx`.
- Storage: local only.
- AI processing: 100% offline after model download.
- Target hardware: low/medium configuration laptops.
- Model download: allowed during first-run setup.

## Architecture To Implement

Use the current project as the base:

- Electron main process for desktop shell, file system, settings, and process orchestration.
- Renderer UI for setup, dashboard, meeting form, recording, processing, editor, and export.
- Python worker for audio processing, transcription, local LLM summarization, and DOCX export.

Recommended production additions:

1. Replace demo recording with robust Windows audio capture:
   - Microphone capture
   - WASAPI loopback capture for system audio
   - Separate mic/system tracks
   - Merge to a single normalized WAV file

2. Add first-run setup wizard:
   - Select mandatory audio save directory
   - Select microphone device
   - Test microphone
   - Test system audio
   - Download offline models
   - Choose Fast or Balanced mode

3. Add offline transcription:
   - Use `faster-whisper`
   - Fast mode: small model
   - Balanced mode: medium model
   - CPU-friendly defaults
   - Store transcript locally

4. Add offline minutes generation:
   - Use Ollama or llama.cpp with a small quantized model by default
   - Generate English meeting minutes from Bangla transcript
   - Use chunk-based summarization for meetings longer than 1 hour
   - Output structured JSON with:
     - meetingObjective
     - discussionSummary
     - keyPoints
     - decisions
     - actionItems
     - risks
     - nextSteps

5. Improve Word export:
   - Use `python-docx`
   - Simple professional formatting
   - Editable action item table

6. Add local storage:
   - SQLite database
   - Meeting status
   - Paths to audio/transcript/minutes/docx
   - Processing logs

7. Add reliability:
   - Processing queue
   - Resume failed processing
   - Clear error messages
   - Logs export
   - Warning when system audio is silent

## UI Screens

Build these screens:

1. First Run Setup
2. Dashboard
3. New Meeting
4. Recording
5. Processing
6. Minutes Editor
7. Export
8. Settings

## Meeting Minutes Format

Generate simple professional English:

```text
Meeting Minutes

Meeting Title:
Client / Company:
Date:
Participants:

Meeting Objective:

Discussion Summary:

Key Points Discussed:
- ...

Decisions Made:
- ...

Action Items:
| Task | Owner | Deadline | Notes |

Risks / Concerns:
- ...

Next Steps:
- ...
```

## Privacy Rules

- Do not upload meeting audio, transcripts, or minutes to any cloud service.
- Network is allowed only for first-time model download.
- All meeting recordings must be saved in the user-selected audio directory.
- The app must not start recording until the audio directory is selected.

## Suggested First Tasks

1. Run the current project.
2. Verify the existing manual recording flow.
3. Replace `scripts/process_meeting.py` demo logic with real `faster-whisper` transcription.
4. Add Ollama/llama.cpp local summarization.
5. Add SQLite meeting history.
6. Improve audio capture for Windows headset + Google Meet.

Work incrementally. Keep every step runnable.
