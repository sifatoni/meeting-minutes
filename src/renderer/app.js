const state = {
  config: {},
  meetings: [],
  currentMeeting: null,
  micStream: null,
  micPaused: false,
  micRecorder: null,
  systemRecorder: null,
  mixedRecorder: null,
  audioContext: null,
  micChunks: [],
  systemChunks: [],
  mixedChunks: [],
  timerId: null,
  startedAt: null,
  latestMinutes: null
};

const elements = {
  chooseFolderBtn: document.getElementById("chooseFolderBtn"),
  audioFolderLabel: document.getElementById("audioFolderLabel"),
  modelSelect: document.getElementById("modelSelect"),
  apiKeyBox: document.getElementById("apiKeyBox"),
  apiKeyInputWrapper: document.getElementById("apiKeyInputWrapper"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  apiKeyConfirmBtn: document.getElementById("apiKeyConfirmBtn"),
  apiKeyEditLink: document.getElementById("apiKeyEditLink"),

  transcriptionModelSelect: document.getElementById("transcriptionModelSelect"),
  groqApiKeyBox: document.getElementById("groqApiKeyBox"),
  groqApiKeyInputWrapper: document.getElementById("groqApiKeyInputWrapper"),
  groqApiKeyInput: document.getElementById("groqApiKeyInput"),
  groqApiKeyConfirmBtn: document.getElementById("groqApiKeyConfirmBtn"),
  groqApiKeyEditLink: document.getElementById("groqApiKeyEditLink"),

  setupWarning: document.getElementById("setupWarning"),
  titleInput: document.getElementById("titleInput"),
  clientInput: document.getElementById("clientInput"),
  participantsInput: document.getElementById("participantsInput"),
  typeInput: document.getElementById("typeInput"),
  systemAudioInput: document.getElementById("systemAudioInput"),
  startBtn: document.getElementById("startBtn"),
  pauseMicBtn: document.getElementById("pauseMicBtn"),
  stopBtn: document.getElementById("stopBtn"),
  processBtn: document.getElementById("processBtn"),
  exportBtn: document.getElementById("exportBtn"),
  uploadBtn: document.getElementById("uploadBtn"),
  timerLabel: document.getElementById("timerLabel"),
  micStatus: document.getElementById("micStatus"),
  systemStatus: document.getElementById("systemStatus"),
  statusPill: document.getElementById("statusPill"),
  minutesEditor: document.getElementById("minutesEditor"),
  exportPathLabel: document.getElementById("exportPathLabel"),
  meetingList: document.getElementById("meetingList"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
  aiSetupPanel: document.getElementById("aiSetupPanel"),
  aiSetupTitle: document.getElementById("aiSetupTitle"),
  aiSetupPill: document.getElementById("aiSetupPill"),
  aiSetupDetail: document.getElementById("aiSetupDetail"),
  aiProgressBar: document.getElementById("aiProgressBar"),
  aiProgressFill: document.getElementById("aiProgressFill"),
  aiSetupActions: document.getElementById("aiSetupActions"),
  retryAiBtn: document.getElementById("retryAiBtn")
};

window.addEventListener("DOMContentLoaded", init);

elements.chooseFolderBtn.addEventListener("click", chooseAudioFolder);
elements.startBtn.addEventListener("click", startRecording);
elements.pauseMicBtn.addEventListener("click", toggleMic);
elements.stopBtn.addEventListener("click", stopRecording);
elements.processBtn.addEventListener("click", processMeeting);
elements.exportBtn.addEventListener("click", exportWord);
elements.uploadBtn.addEventListener("click", uploadExistingAudio);
elements.retryAiBtn.addEventListener("click", runOllamaSetup);
elements.clearHistoryBtn.addEventListener("click", clearHistory);

elements.modelSelect.addEventListener("change", async () => {
  elements.apiKeyBox.style.display = elements.modelSelect.value === "online" ? "block" : "none";
  state.config.model = elements.modelSelect.value;
  await window.meetingApp.saveConfig({ model: state.config.model });
});

elements.apiKeyConfirmBtn.addEventListener("click", async () => {
  state.config.openRouterApiKey = elements.apiKeyInput.value;
  await window.meetingApp.saveConfig({ openRouterApiKey: state.config.openRouterApiKey });
  elements.apiKeyInputWrapper.style.display = "none";
  elements.apiKeyEditLink.style.display = "block";
});

elements.apiKeyEditLink.addEventListener("click", () => {
  elements.apiKeyEditLink.style.display = "none";
  elements.apiKeyInputWrapper.style.display = "flex";
  elements.apiKeyInput.focus();
});

elements.transcriptionModelSelect.addEventListener("change", async () => {
  elements.groqApiKeyBox.style.display = elements.transcriptionModelSelect.value === "groq" ? "block" : "none";
  state.config.transcriptionModel = elements.transcriptionModelSelect.value;
  await window.meetingApp.saveConfig({ transcriptionModel: state.config.transcriptionModel });
});

elements.groqApiKeyConfirmBtn.addEventListener("click", async () => {
  state.config.groqApiKey = elements.groqApiKeyInput.value;
  await window.meetingApp.saveConfig({ groqApiKey: state.config.groqApiKey });
  elements.groqApiKeyInputWrapper.style.display = "none";
  elements.groqApiKeyEditLink.style.display = "block";
});

elements.groqApiKeyEditLink.addEventListener("click", () => {
  elements.groqApiKeyEditLink.style.display = "none";
  elements.groqApiKeyInputWrapper.style.display = "flex";
  elements.groqApiKeyInput.focus();
});

async function init() {
  const appState = await window.meetingApp.getState();
  state.config = appState.config || {};
  state.meetings = appState.meetings || [];
  
  if (state.config.model) {
    elements.modelSelect.value = state.config.model;
  } else {
    // Default model if none selected
    state.config.model = elements.modelSelect.value;
  }
  if (state.config.openRouterApiKey) {
    elements.apiKeyInput.value = state.config.openRouterApiKey;
    elements.apiKeyInputWrapper.style.display = "none";
    elements.apiKeyEditLink.style.display = "block";
  } else {
    elements.apiKeyInputWrapper.style.display = "flex";
    elements.apiKeyEditLink.style.display = "none";
  }
  elements.apiKeyBox.style.display = elements.modelSelect.value === "online" ? "block" : "none";

  if (state.config.transcriptionModel) {
    elements.transcriptionModelSelect.value = state.config.transcriptionModel;
  } else {
    state.config.transcriptionModel = elements.transcriptionModelSelect.value;
  }

  if (state.config.groqApiKey) {
    elements.groqApiKeyInput.value = state.config.groqApiKey;
    elements.groqApiKeyInputWrapper.style.display = "none";
    elements.groqApiKeyEditLink.style.display = "block";
  } else {
    elements.groqApiKeyInputWrapper.style.display = "flex";
    elements.groqApiKeyEditLink.style.display = "none";
  }
  elements.groqApiKeyBox.style.display = elements.transcriptionModelSelect.value === "groq" ? "block" : "none";

  render();
  checkAndSetupOllama();
}

async function chooseAudioFolder() {
  const config = await window.meetingApp.chooseAudioFolder();
  if (config) {
    state.config = config;
    render();
  }
}

async function uploadExistingAudio() {
  const filePaths = await window.meetingApp.uploadExistingAudio();
  if (!filePaths || !filePaths.length) return;

  const imported = [];
  for (const filePath of filePaths) {
    const fileName = filePath.split(/[/\\]/).pop();
    const title = fileName.replace(/\.[^.]+$/, "");

    const meeting = await window.meetingApp.importAudio({
      title,
      client: elements.clientInput.value,
      participants: elements.participantsInput.value,
      type: elements.typeInput.value,
      filePath
    });
    imported.push(meeting);
  }

  state.currentMeeting = imported[0];
  state.meetings = [imported[0], ...state.meetings];
  elements.processBtn.disabled = false;
  setStatus("Audio Imported");
  renderMeetings();
}

async function startRecording() {
  if (!state.config.audioDirectory) {
    setStatus("Choose audio folder first");
    return;
  }

  const meeting = await window.meetingApp.createMeeting({
    title: elements.titleInput.value,
    client: elements.clientInput.value,
    participants: elements.participantsInput.value,
    type: elements.typeInput.value
  });

  state.currentMeeting = meeting;
  state.micChunks = [];
  state.systemChunks = [];
  state.mixedChunks = [];

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.micStream = micStream;
  state.micPaused = false;
  elements.pauseMicBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 4v8M11 4v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pause Mic`;
  state.micRecorder = createRecorder(micStream, state.micChunks);
  state.micRecorder.start(1000);
  setAudioStatus(elements.micStatus, "Microphone: recording", "ok");

  let systemAudioStream = null;
  if (elements.systemAudioInput.checked) {
    try {
      const systemStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      const systemAudioTracks = systemStream.getAudioTracks();
      systemStream.getVideoTracks().forEach((track) => track.stop());

      if (!systemAudioTracks.length) {
        setAudioStatus(elements.systemStatus, "System audio: no audio track", "warning");
      } else {
        systemAudioStream = new MediaStream(systemAudioTracks);
        state.systemRecorder = createRecorder(systemAudioStream, state.systemChunks);
        state.systemRecorder.start(1000);
        setAudioStatus(elements.systemStatus, "System audio: recording", "ok");
      }
    } catch (error) {
      console.warn("System audio capture skipped.", error);
      setAudioStatus(elements.systemStatus, "System audio: permission blocked", "warning");
    }
  } else {
    setAudioStatus(elements.systemStatus, "System audio: disabled", "warning");
  }

  const mixedStream = createMixedStream(micStream, systemAudioStream);
  state.mixedRecorder = createRecorder(mixedStream, state.mixedChunks);
  state.mixedRecorder.start(1000);

  state.startedAt = Date.now();
  state.timerId = setInterval(updateTimer, 500);
  elements.startBtn.disabled = true;
  elements.pauseMicBtn.disabled = false;
  elements.stopBtn.disabled = false;
  elements.processBtn.disabled = true;
  elements.exportBtn.disabled = true;
  setStatus("Recording");
  renderMeetings();
}

function toggleMic() {
  if (!state.micStream) return;
  state.micPaused = !state.micPaused;
  
  state.micStream.getAudioTracks().forEach(track => {
    track.enabled = !state.micPaused;
  });

  if (state.micPaused) {
    elements.pauseMicBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l10-6L4 2z" fill="currentColor"/></svg> Resume Mic`;
    setAudioStatus(elements.micStatus, "Microphone: paused", "warning");
  } else {
    elements.pauseMicBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 4v8M11 4v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Pause Mic`;
    setAudioStatus(elements.micStatus, "Microphone: recording", "ok");
  }
}

function createRecorder(stream, chunks) {
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
  };
  return recorder;
}

function createMixedStream(micStream, systemStream) {
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  const micSource = audioContext.createMediaStreamSource(micStream);
  const micGain = audioContext.createGain();
  micGain.gain.value = 1;
  micSource.connect(micGain).connect(destination);

  if (systemStream && systemStream.getAudioTracks().length) {
    const systemSource = audioContext.createMediaStreamSource(systemStream);
    const systemGain = audioContext.createGain();
    systemGain.gain.value = 1;
    systemSource.connect(systemGain).connect(destination);
  }

  state.audioContext = audioContext;
  return destination.stream;
}

async function stopRecording() {
  await stopRecorder(state.micRecorder);
  await stopRecorder(state.systemRecorder);
  await stopRecorder(state.mixedRecorder);

  if (state.audioContext && state.audioContext.state !== "closed") {
    await state.audioContext.close();
    state.audioContext = null;
  }

  clearInterval(state.timerId);
  state.timerId = null;
  updateTimer(true);

  if (state.micChunks.length) {
    await saveChunks("mic", state.micChunks);
  }

  let systemAudioBytes = 0;
  if (state.systemChunks.length) {
    systemAudioBytes = await saveChunks("system", state.systemChunks);
  } else if (elements.systemAudioInput.checked) {
    alert("System audio was not recorded. For an Online Meeting with headset, the other participant voice will be missing. Please test again before an important meeting.");
  }

  let mixedAudioBytes = 0;
  if (state.mixedChunks.length) {
    mixedAudioBytes = await saveChunks("meeting_audio", state.mixedChunks);
  }

  if (mixedAudioBytes > 0) {
    state.currentMeeting = await window.meetingApp.deleteSourceRecordings(state.currentMeeting.id);
  }

  elements.startBtn.disabled = false;
  elements.pauseMicBtn.disabled = true;
  elements.stopBtn.disabled = true;
  elements.processBtn.disabled = false;
  setStatus("Recorded");
  setAudioStatus(elements.micStatus, "Microphone: stopped", "");
  setAudioStatus(elements.systemStatus, systemAudioBytes > 0 ? "System audio: saved" : "System audio: not saved", systemAudioBytes > 0 ? "ok" : "warning");

  const appState = await window.meetingApp.getState();
  state.meetings = appState.meetings || [];
  renderMeetings();
}

function stopRecorder(recorder) {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === "inactive") {
      resolve();
      return;
    }
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.stop();
  });
}

async function saveChunks(kind, chunks) {
  const blob = new Blob(chunks, { type: "audio/webm" });
  const base64Data = await blobToBase64(blob);
  await window.meetingApp.saveRecording({
    meetingId: state.currentMeeting.id,
    kind,
    mimeType: blob.type,
    base64Data
  });
  return blob.size;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

async function processMeeting() {
  if (!state.currentMeeting) return;
  elements.processBtn.disabled = true;

  // Check if the selected model needs Ollama and if it's ready
  const selectedModel = state.config.model || "";
  if (selectedModel !== "online") {
    try {
      const ollamaStatus = await window.meetingApp.checkOllama();
      if (!ollamaStatus.installed || !ollamaStatus.running || !ollamaStatus.modelReady) {
        const missingCount = (ollamaStatus.missingModels || []).length;
        const missingLabel = missingCount > 0 ? ` (${missingCount} model${missingCount > 1 ? 's' : ''} missing)` : '';
        setStatus(`Setting up AI${missingLabel}... please wait`, true);
        elements.aiSetupPanel.style.display = "block";
        try {
          await runOllamaSetupAndWait();
          const recheckStatus = await window.meetingApp.checkOllama();
          if (!recheckStatus.running || !recheckStatus.modelReady) {
            alert("Ollama AI is not ready yet.\n\nPlease wait for the AI setup to complete in the panel above, or switch to 'Online model' in the sidebar if you have an API key.");
            setStatus("AI Not Ready");
            elements.processBtn.disabled = false;
            return;
          }
        } catch (setupErr) {
          alert("Could not set up local AI automatically.\n\nYou can:\n1. Wait and click 'Retry Setup' in the AI Setup panel\n2. Install Ollama manually from https://ollama.com\n3. Switch to an online model in the sidebar");
          setStatus("AI Setup Failed");
          elements.processBtn.disabled = false;
          return;
        }
      }
    } catch {
      // checkOllama failed — proceed anyway and let the Python script handle it
    }
  }

  setStatus("Processing... (this may take a few minutes)", true);

  try {
    const result = await window.meetingApp.processMeeting(state.currentMeeting.id);
    state.currentMeeting = result.meeting;
    state.latestMinutes = result.minutes;
    elements.minutesEditor.value = minutesToText(result.minutes);
    elements.exportBtn.disabled = false;
    elements.exportPathLabel.textContent = result.meeting.files.docx
      ? `Draft Word file: ${result.meeting.files.docx}`
      : "";
    setStatus("Minutes Ready");
  } catch (error) {
    console.error("Processing Error:", error);
    alert("Failed to generate minutes:\n\n" + (error.message || "Unknown error"));
    setStatus("Error Processing");
  } finally {
    elements.processBtn.disabled = false;
    const appState = await window.meetingApp.getState();
    state.meetings = appState.meetings || [];
    renderMeetings();
  }
}

async function runOllamaSetupAndWait() {
  return new Promise((resolve, reject) => {
    elements.aiSetupActions.style.display = "none";
    elements.aiSetupTitle.textContent = "Setting up local AI";
    elements.aiSetupPill.textContent = "Setting up";
    elements.aiSetupPill.className = "pill";
    elements.aiSetupDetail.textContent = "Starting automatic setup…";
    elements.aiProgressBar.style.display = "block";
    elements.aiProgressFill.style.width = "0%";

    window.meetingApp.onOllamaProgress((data) => {
      const labels = { install: "Installing", service: "Starting", model: "Model" };
      elements.aiSetupPill.textContent = labels[data.phase] || "Setting up";
      elements.aiSetupDetail.textContent = data.detail;

      if (data.pct >= 0) {
        elements.aiProgressBar.style.display = "block";
        elements.aiProgressFill.classList.remove("indeterminate");
        elements.aiProgressFill.style.width = `${data.pct}%`;
      } else {
        elements.aiProgressFill.style.width = "100%";
        elements.aiProgressFill.classList.add("indeterminate");
      }
    });

    window.meetingApp.setupOllama().then((result) => {
      elements.aiProgressFill.classList.remove("indeterminate");

      if (result.installed && result.running && result.modelReady) {
        elements.aiSetupTitle.textContent = "Local AI is ready";
        elements.aiSetupPill.textContent = "Ready";
        elements.aiSetupPill.className = "pill pill-success";
        elements.aiSetupDetail.textContent = "Ollama and the AI model are installed. Proceeding to generate minutes…";
        elements.aiProgressBar.style.display = "none";
        setTimeout(() => {
          elements.aiSetupPanel.style.display = "none";
        }, 3000);
        resolve(result);
      } else {
        elements.aiSetupTitle.textContent = "AI setup incomplete";
        elements.aiSetupPill.textContent = "Incomplete";
        elements.aiSetupPill.className = "pill pill-warning";
        elements.aiSetupDetail.textContent = "Some components could not be set up.";
        elements.aiSetupActions.style.display = "flex";
        elements.aiProgressBar.style.display = "none";
        reject(new Error("AI setup incomplete"));
      }
    }).catch((error) => {
      elements.aiProgressFill.classList.remove("indeterminate");
      elements.aiSetupTitle.textContent = "AI setup failed";
      elements.aiSetupPill.textContent = "Error";
      elements.aiSetupPill.className = "pill pill-error";
      elements.aiSetupDetail.textContent = `${error.message || "Unknown error."}`;
      elements.aiSetupActions.style.display = "flex";
      elements.aiProgressBar.style.display = "none";
      reject(error);
    });
  });
}

async function exportWord() {
  if (!state.currentMeeting) return;
  const minutes = textToMinutes(elements.minutesEditor.value);
  const meeting = await window.meetingApp.exportDocx({
    meetingId: state.currentMeeting.id,
    minutes
  });
  state.currentMeeting = meeting;
  setStatus("Exported");
  elements.exportPathLabel.textContent = meeting.files.docx
    ? `Exported Word file: ${meeting.files.docx}`
    : "Exported Word file.";

  const appState = await window.meetingApp.getState();
  state.meetings = appState.meetings || [];
  renderMeetings();
}

function minutesToText(minutes) {
  const actionItems = (minutes.actionItems || [])
    .map((item) => `- ${item.task} | Owner: ${item.owner || "TBD"} | Deadline: ${item.deadline || "TBD"} | Notes: ${item.notes || ""}`)
    .join("\n");

  return [
    `Meeting Minutes`,
    ``,
    `Meeting Title: ${minutes.meetingTitle || ""}`,
    `Client / Company: ${minutes.client || ""}`,
    `Date: ${minutes.date || ""}`,
    `Participants: ${minutes.participants || ""}`,
    ``,
    `Meeting Objective:`,
    minutes.meetingObjective || "",
    ``,
    `Discussion Summary:`,
    minutes.discussionSummary || "",
    ``,
    `Key Points Discussed:`,
    bulletList(minutes.keyPoints),
    ``,
    `Decisions Made:`,
    bulletList(minutes.decisions),
    ``,
    `Action Items:`,
    actionItems || "- No action items identified.",
    ``,
    `Risks / Concerns:`,
    bulletList(minutes.risks),
    ``,
    `Next Steps:`,
    bulletList(minutes.nextSteps)
  ].join("\n");
}

function textToMinutes(text) {
  return {
    rawText: text
  };
}

function bulletList(items) {
  if (!items || !items.length) return "- None identified.";
  return items.map((item) => `- ${item}`).join("\n");
}

function updateTimer(reset = false) {
  if (reset || !state.startedAt) {
    elements.timerLabel.textContent = "00:00";
    return;
  }
  const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  elements.timerLabel.textContent = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function setStatus(value, isProcessing = false) {
  elements.statusPill.textContent = value;
  if (isProcessing) {
    elements.statusPill.classList.add("pill-processing");
  } else {
    elements.statusPill.classList.remove("pill-processing");
  }
}

function setAudioStatus(element, text, className) {
  element.textContent = text;
  element.className = className || "";
}

function render() {
  elements.audioFolderLabel.textContent = state.config.audioDirectory || "Not selected";
  elements.setupWarning.style.display = state.config.audioDirectory ? "none" : "block";
  elements.startBtn.disabled = !state.config.audioDirectory;
  elements.uploadBtn.disabled = !state.config.audioDirectory;
  renderMeetings();
}

function renderMeetings() {
  elements.clearHistoryBtn.style.display = state.meetings.length ? "inline-flex" : "none";

  if (!state.meetings.length) {
    elements.meetingList.innerHTML = `<p class="muted">No meetings yet.</p>`;
    return;
  }

  elements.meetingList.innerHTML = state.meetings.map((meeting) => `
    <div class="meeting-item">
      <div>
        <strong>${escapeHtml(meeting.title)}</strong>
        <span>${escapeHtml(meeting.client || "No company")} - ${new Date(meeting.createdAt).toLocaleString()}</span>
      </div>
      <span class="pill">${escapeHtml(meeting.status)}</span>
    </div>
  `).join("");
}

async function clearHistory() {
  if (confirm("Are you sure you want to clear your recent meeting history? (Files will not be deleted)")) {
    state.meetings = await window.meetingApp.clearHistory();
    renderMeetings();
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ===================================================================
// Ollama Auto-Setup
// ===================================================================

async function checkAndSetupOllama() {
  try {
    const status = await window.meetingApp.checkOllama();
    if (status.installed && status.running && status.modelReady) {
      elements.aiSetupPanel.style.display = "none";
      return;
    }
  } catch {}

  elements.aiSetupPanel.style.display = "block";
  runOllamaSetup();
}

async function runOllamaSetup() {
  elements.aiSetupActions.style.display = "none";
  elements.aiSetupTitle.textContent = "Setting up local AI";
  elements.aiSetupPill.textContent = "Setting up";
  elements.aiSetupPill.className = "pill";
  elements.aiSetupDetail.textContent = "Starting automatic setup…";
  elements.aiProgressBar.style.display = "block";
  elements.aiProgressFill.style.width = "0%";

  window.meetingApp.onOllamaProgress((data) => {
    const labels = { install: "Installing", service: "Starting", model: "Model" };
    elements.aiSetupPill.textContent = labels[data.phase] || "Setting up";
    elements.aiSetupDetail.textContent = data.detail;

    if (data.pct >= 0) {
      elements.aiProgressBar.style.display = "block";
      elements.aiProgressFill.classList.remove("indeterminate");
      elements.aiProgressFill.style.width = `${data.pct}%`;
    } else {
      elements.aiProgressFill.style.width = "100%";
      elements.aiProgressFill.classList.add("indeterminate");
    }
  });

  try {
    const result = await window.meetingApp.setupOllama();
    elements.aiProgressFill.classList.remove("indeterminate");

    if (result.installed && result.running && result.modelReady) {
      elements.aiSetupTitle.textContent = "Local AI is ready";
      elements.aiSetupPill.textContent = "Ready";
      elements.aiSetupPill.className = "pill pill-success";
      elements.aiSetupDetail.textContent = "Ollama and all required AI models are installed. Meeting minutes generation is available.";
      elements.aiProgressBar.style.display = "none";
      setTimeout(() => {
        elements.aiSetupPanel.style.display = "none";
      }, 4000);
    } else {
      elements.aiSetupTitle.textContent = "AI setup incomplete";
      elements.aiSetupPill.textContent = "Incomplete";
      elements.aiSetupPill.className = "pill pill-warning";
      elements.aiSetupDetail.textContent = "Some components could not be verified. Transcription will still work, but meeting-minutes generation may fall back to a basic draft.";
      elements.aiSetupActions.style.display = "flex";
      elements.aiProgressBar.style.display = "none";
    }
  } catch (error) {
    elements.aiProgressFill.classList.remove("indeterminate");
    elements.aiSetupTitle.textContent = "AI setup failed";
    elements.aiSetupPill.textContent = "Error";
    elements.aiSetupPill.className = "pill pill-error";
    elements.aiSetupDetail.textContent = `${error.message || "Unknown error."}  You can retry or generate minutes without Ollama (basic draft mode).`;
    elements.aiSetupActions.style.display = "flex";
    elements.aiProgressBar.style.display = "none";
  }
}
