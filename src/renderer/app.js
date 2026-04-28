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
  latestMinutes: null,
  leads: [],
  leadSearches: [],
  leadFilterAny: false,
  leadFilterBoth: false,
  leadDebugMode: false
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
  retryAiBtn: document.getElementById("retryAiBtn"),

  leadStatusPill: document.getElementById("leadStatusPill"),
  leadIndustryInput: document.getElementById("leadIndustryInput"),
  leadCountrySelect: document.getElementById("leadCountrySelect"),
  leadAreaInput: document.getElementById("leadAreaInput"),
  leadOrganizationInput: document.getElementById("leadOrganizationInput"),
  leadDesignationsInput: document.getElementById("leadDesignationsInput"),
  leadSearchBtn: document.getElementById("leadSearchBtn"),
  leadCancelBtn: document.getElementById("leadCancelBtn"),
  leadExportBtn: document.getElementById("leadExportBtn"),
  leadClearBtn: document.getElementById("leadClearBtn"),
  leadFilterAnyInput: document.getElementById("leadFilterAnyInput"),
  leadFilterBothInput: document.getElementById("leadFilterBothInput"),
  leadQueryModeSelect: document.getElementById("leadQueryModeSelect"),
  leadPageModeAuto: document.getElementById("leadPageModeAuto"),
  leadPageModeCustom: document.getElementById("leadPageModeCustom"),
  leadPageRangeInputs: document.getElementById("leadPageRangeInputs"),
  leadStartPageInput: document.getElementById("leadStartPageInput"),
  leadEndPageInput: document.getElementById("leadEndPageInput"),
  leadDebugModeInput: document.getElementById("leadDebugModeInput"),
  leadTable: document.getElementById("leadTable"),
  leadSummary: document.getElementById("leadSummary"),
  leadTableBody: document.getElementById("leadTableBody"),
  meetingModuleTab: document.getElementById("meetingModuleTab"),
  leadModuleTab: document.getElementById("leadModuleTab")
};

const COUNTRY_FALLBACK_CODES = [
  "AF","AL","DZ","AD","AO","AR","AM","AU","AT","AZ","BH","BD","BY","BE","BZ","BJ","BT","BO","BA","BW","BR",
  "BN","BG","BF","BI","KH","CM","CA","CV","CF","TD","CL","CN","CO","KM","CG","CD","CR","CI","HR","CU","CY","CZ",
  "DK","DJ","DO","EC","EG","SV","GQ","ER","EE","SZ","ET","FJ","FI","FR","GA","GM","GE","DE","GH","GR","GT","GN",
  "GW","GY","HT","HN","HU","IS","IN","ID","IR","IQ","IE","IL","IT","JM","JP","JO","KZ","KE","KI","KP","KR","KW",
  "KG","LA","LV","LB","LS","LR","LY","LT","LU","MG","MW","MY","MV","ML","MT","MR","MU","MX","MD","MN","ME","MA",
  "MZ","MM","NA","NP","NL","NZ","NI","NE","NG","MK","NO","OM","PK","PA","PG","PY","PE","PH","PL","PT","QA","RO",
  "RU","RW","SA","SN","RS","SL","SG","SK","SI","SB","SO","ZA","SS","ES","LK","SD","SR","SE","CH","SY","TW","TJ",
  "TZ","TH","TL","TG","TO","TT","TN","TR","TM","UG","UA","AE","GB","US","UY","UZ","VE","VN","YE","ZM","ZW"
];

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
elements.leadSearchBtn.addEventListener("click", searchLeads);
elements.leadCancelBtn.addEventListener("click", cancelLeads);
elements.leadExportBtn.addEventListener("click", exportLeadsCsv);
elements.leadClearBtn.addEventListener("click", clearLeads);
elements.meetingModuleTab.addEventListener("click", () => setActiveModule("meeting"));
elements.leadModuleTab.addEventListener("click", () => setActiveModule("leads"));
elements.leadTableBody.addEventListener("click", onLeadTableClick);
elements.leadFilterAnyInput.addEventListener("change", () => {
  state.leadFilterAny = elements.leadFilterAnyInput.checked;
  // Unchecking "any" must also uncheck the stricter "both"
  if (!state.leadFilterAny) {
    state.leadFilterBoth = false;
    elements.leadFilterBothInput.checked = false;
  }
  renderLeads();
});

elements.leadFilterBothInput.addEventListener("change", () => {
  state.leadFilterBoth = elements.leadFilterBothInput.checked;
  // Checking "both" implies "any" — keep parent in sync
  if (state.leadFilterBoth) {
    state.leadFilterAny = true;
    elements.leadFilterAnyInput.checked = true;
  }
  renderLeads();
});

// Page-range mode toggle: show/hide custom inputs
document.querySelectorAll('input[name="leadPageMode"]').forEach(radio => {
  radio.addEventListener("change", () => {
    const isCustom = elements.leadPageModeCustom.checked;
    elements.leadPageRangeInputs.classList.toggle("visible", isCustom);
  });
});

// Auto-swap & clamp end page when user blurs either number input
elements.leadEndPageInput.addEventListener("change", () => {
  let start = parseInt(elements.leadStartPageInput.value, 10) || 1;
  let end   = parseInt(elements.leadEndPageInput.value,   10) || start;
  if (end < start) { [start, end] = [end, start]; }
  if (end - start + 1 > 10) end = start + 9;
  elements.leadStartPageInput.value = start;
  elements.leadEndPageInput.value   = end;
});

elements.leadStartPageInput.addEventListener("change", () => {
  let start = Math.max(1, parseInt(elements.leadStartPageInput.value, 10) || 1);
  let end   = parseInt(elements.leadEndPageInput.value, 10) || start + 4;
  if (end < start) end = start + 4;
  if (end - start + 1 > 10) end = start + 9;
  elements.leadStartPageInput.value = start;
  elements.leadEndPageInput.value   = end;
});

elements.leadDebugModeInput.addEventListener("change", () => {
  state.leadDebugMode = elements.leadDebugModeInput.checked;
  elements.leadTable.classList.toggle("debug-active", state.leadDebugMode);
  renderLeads();
});

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
  const leadState = await window.meetingApp.getLeadsState();
  state.config = appState.config || {};
  state.meetings = appState.meetings || [];
  state.leads = leadState.leads || [];
  state.leadSearches = leadState.searches || [];
  
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

  populateCountryDropdown();

  const savedModule = localStorage.getItem("activeModule");
  setActiveModule(savedModule === "leads" ? "leads" : "meeting");
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
  renderLeads();
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

function countryFlagFromCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

function getCountryCodes() {
  if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") {
    try {
      const regions = Intl.supportedValuesOf("region");
      if (Array.isArray(regions) && regions.length) {
        return regions.filter((c) => /^[A-Z]{2}$/.test(c));
      }
    } catch {}
  }
  return COUNTRY_FALLBACK_CODES;
}

function populateCountryDropdown() {
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const codes = getCountryCodes();
  const countries = codes
    .map((code) => {
      const name = display.of(code);
      if (!name || name === code) return null;
      return { code, name, flag: countryFlagFromCode(code) };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  elements.leadCountrySelect.innerHTML = countries.map((country) => `
    <option value="${country.name}" data-country-code="${country.code}">
      ${country.flag} ${country.name} (${country.code})
    </option>
  `).join("");

  const preferred = ["Bangladesh", "United States", "United Kingdom", "India"];
  const options = [...elements.leadCountrySelect.options];
  const firstPreferred = options.find((opt) => preferred.includes(opt.value));
  if (firstPreferred) {
    elements.leadCountrySelect.value = firstPreferred.value;
  }
}

function parseDesignationsInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function setLeadStatus(text, type = "") {
  elements.leadStatusPill.textContent = text;
  elements.leadStatusPill.className = "pill";
  if (type === "success") elements.leadStatusPill.classList.add("pill-success");
  if (type === "warning") elements.leadStatusPill.classList.add("pill-warning");
  if (type === "error") elements.leadStatusPill.classList.add("pill-error");
}

// ── Contact value helpers ─────────────────────────────────────────────────────
// Treats blank, dash, em-dash, N/A as "no value" so filters aren't fooled
// by placeholder strings that scrapers sometimes emit.
const EMPTY_VALUES = new Set(["", "-", "—", "–", "n/a", "na", "none", "null", "undefined"]);

function hasValidEmail(lead) {
  return Boolean(lead.email) && !EMPTY_VALUES.has(lead.email.trim().toLowerCase());
}

function hasValidPhone(lead) {
  return Boolean(lead.phone) && !EMPTY_VALUES.has(lead.phone.trim().toLowerCase());
}

/**
 * Apply the active contact filter to a leads array.
 * Priority: both > any > none
 *   leadFilterBoth → email AND phone must be present
 *   leadFilterAny  → email OR  phone must be present
 *   neither        → no filter, return all
 */
function applyContactFilter(leads) {
  if (state.leadFilterBoth) return leads.filter(l => hasValidEmail(l) && hasValidPhone(l));
  if (state.leadFilterAny)  return leads.filter(l => hasValidEmail(l) || hasValidPhone(l));
  return leads;
}

function renderLeads() {
  const visibleLeads = applyContactFilter(state.leads);
  const filtered     = visibleLeads.length < state.leads.length;

  elements.leadExportBtn.disabled = !visibleLeads.length;
  elements.leadSummary.textContent = filtered
    ? `${visibleLeads.length} visible leads (filtered) | ${state.leads.length} total`
    : `${visibleLeads.length} leads`;

  if (!visibleLeads.length) {
    let emptyMsg = "No leads found.";
    if (filtered && state.leadFilterBoth) {
      emptyMsg = "No leads have both phone and email. Try the weaker filter or clear filters.";
    } else if (filtered && state.leadFilterAny) {
      emptyMsg = "No leads have a phone or email. Clear the filter to see all contacts.";
    }
    elements.leadTableBody.innerHTML = `
      <tr>
        <td colspan="9" class="muted">${emptyMsg}</td>
      </tr>
    `;
    return;
  }

  elements.leadTableBody.innerHTML = visibleLeads.map((lead) => {
    const bandClass = lead.valueBand === "High"
      ? "lead-value-high"
      : lead.valueBand === "Medium"
        ? "lead-value-medium"
        : "lead-value-low";

    const bd = lead.scoreBreakdown || {};
    const scoreTooltip = [
      `Score: ${lead.contactScore || 0}`,
      `─────────────`,
      `Email: ${bd.email || 0}`,
      `Phone: ${bd.phone || 0}`,
      `LinkedIn: ${bd.linkedin || 0}`,
      `Designation: ${bd.designation || 0}`,
      `Company: ${bd.company || 0}`
    ].join("\n");

    const emailTypeBadge = lead.emailType
      ? `<span class="lead-email-type lead-email-type--${lead.emailType.toLowerCase()}">${escapeHtml(lead.emailType)}</span>`
      : "";

    // Debug column — always rendered; CSS toggles visibility via .debug-active
    const debugCell = `
      <td class="debug-col">
        <span class="debug-source-badge">${escapeHtml(lead.source || "—")}</span>
        <span class="debug-score-detail" title="${escapeHtml(`E:${bd.email||0} P:${bd.phone||0} Li:${bd.linkedin||0} D:${bd.designation||0} Co:${bd.company||0}`)}">
          ${bd.email||0}e&nbsp;·&nbsp;${bd.phone||0}p&nbsp;·&nbsp;${bd.linkedin||0}li
        </span>
      </td>`;

    return `
      <tr>
        <td>${escapeHtml(lead.name || "N/A")}</td>
        <td>${escapeHtml(lead.organization || "N/A")}</td>
        <td>${escapeHtml(lead.designation || "N/A")}</td>
        <td>${escapeHtml(lead.phone || "N/A")}</td>
        <td>
          <div class="lead-email-cell">
            <span>${escapeHtml(lead.email || "N/A")}</span>
            ${emailTypeBadge}
            ${lead.email ? `<button class="lead-copy-btn secondary" type="button" data-email="${escapeHtml(lead.email)}">Copy</button>` : ""}
          </div>
        </td>
        <td>
          ${lead.linkedinUrl ? `<a href="${escapeHtml(lead.linkedinUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.linkedinUrl)}</a>` : "N/A"}
        </td>
        <td>${escapeHtml(lead.location || "N/A")}</td>
        <td>
          <span class="lead-value-badge ${bandClass}" title="${escapeHtml(scoreTooltip)}">
            ${escapeHtml(String(lead.contactScore || 0))} | ${escapeHtml(lead.valueBand || "Low")}
          </span>
        </td>
        ${debugCell}
      </tr>
    `;
  }).join("");
}

async function onLeadTableClick(event) {
  const button = event.target.closest("button[data-email]");
  if (!button) return;
  const email = button.getAttribute("data-email");
  if (!email) return;

  try {
    await navigator.clipboard.writeText(email);
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = previous; }, 900);
  } catch {
    alert("Copy failed. Please copy manually.");
  }
}

async function searchLeads() {
  const industry = elements.leadIndustryInput.value.trim();
  const location = elements.leadCountrySelect.value.trim();
  const area = elements.leadAreaInput.value.trim();
  const organization = elements.leadOrganizationInput.value.trim();
  const designations = parseDesignationsInput(elements.leadDesignationsInput.value);

  if (!industry || !location) {
    alert("Industry and country are required.");
    return;
  }

  window.meetingApp.onLeadsProgress((data) => {
    elements.leadSummary.textContent = data.message || "Searching...";
    if (data.count > 0) {
      elements.leadSummary.textContent += ` (${data.count} found so far)`;
    }
  });

  // ── Real-time streaming: append leads as they arrive ──
  window.meetingApp.onLeadsChunk((data) => {
    console.log(`[UI] Received leads:chunk → ${data.leads?.length || 0} leads (total from server: ${data.total})`);
    if (data.leads && data.leads.length > 0) {
      // Append new leads without replacing existing ones
      const existingKeys = new Set(state.leads.map(l =>
        (l.email || l.phone || l.linkedinUrl || `${l.name}|${l.organization}`).toLowerCase()
      ));

      let added = 0;
      for (const lead of data.leads) {
        const key = (lead.email || lead.phone || lead.linkedinUrl || `${lead.name}|${lead.organization}`).toLowerCase();
        if (!existingKeys.has(key)) {
          state.leads.push(lead);
          existingKeys.add(key);
          added++;
        }
      }

      console.log(`[UI] Appended ${added} new leads (${state.leads.length} total in state)`);
      renderLeads();
    }
  });

  window.meetingApp.onLeadsComplete(async (data) => {
    elements.leadSearchBtn.disabled = false;
    elements.leadCancelBtn.style.display = "none";
    // Final refresh from disk for consistency
    const leadState = await window.meetingApp.getLeadsState();
    state.leads = leadState.leads || [];
    renderLeads();
    setLeadStatus(data.total > 0 ? "Ready" : "No Leads", data.total > 0 ? "success" : "warning");
    elements.leadSummary.textContent = [
      `Found: ${data.total} leads`,
      `High: ${data.highValue} · Medium: ${data.mediumValue} · Low: ${data.lowValue}`
    ].join("  |  ");
  });

  // ── CAPTCHA event handler ──
  window.meetingApp.onLeadsCaptcha((data) => {
    if (data.type === "captcha") {
      setLeadStatus("⚠ CAPTCHA — Solve in browser window", "warning");
      elements.leadSummary.textContent = data.message || "Manual verification required";
    } else if (data.type === "solved") {
      setLeadStatus("Resuming...", "success");
      elements.leadSummary.textContent = data.message || "CAPTCHA solved — resuming scraping...";
    } else if (data.type === "timeout") {
      setLeadStatus("Searching...", "warning");
      elements.leadSummary.textContent = data.message || "CAPTCHA timed out — continuing...";
    }
  });

  window.meetingApp.onLeadsError((data) => {
    elements.leadSearchBtn.disabled = false;
    elements.leadCancelBtn.style.display = "none";
    setLeadStatus("Search Failed", "error");
    elements.leadSummary.textContent = data.message || "Lead discovery failed.";
    // Keep any partial leads that were already streamed
  });

  elements.leadSearchBtn.disabled = true;
  elements.leadCancelBtn.style.display = "";
  setLeadStatus("Searching...", "warning");
  elements.leadSummary.textContent = "Starting search — this may take 3–5 minutes...";

  try {
    const queryMode  = elements.leadQueryModeSelect?.value || "aggressive";
    const isCustom   = elements.leadPageModeCustom?.checked;

    // Only pass page params when Custom Range is active; let backend use smart mode otherwise
    const startPage  = isCustom ? (parseInt(elements.leadStartPageInput?.value, 10) || 1)         : undefined;
    const endPage    = isCustom ? (parseInt(elements.leadEndPageInput?.value,   10) || undefined)  : undefined;

    const pageModeLabel = isCustom
      ? `pages ${startPage}–${endPage ?? "auto"}`
      : "smart mode";

    console.log(`[UI] Starting search — mode: ${queryMode}, pages: ${pageModeLabel}, designations: ${JSON.stringify(designations)}`);
    await window.meetingApp.searchLeads({ industry, location, area, organization, designations, queryMode, startPage, endPage });
  } catch (error) {
    elements.leadSearchBtn.disabled = false;
    elements.leadCancelBtn.style.display = "none";
    setLeadStatus("Search Failed", "error");
    elements.leadSummary.textContent = error.message || "Failed to start search.";
  }
}

async function cancelLeads() {
  try {
    await window.meetingApp.cancelLeads();
    elements.leadSearchBtn.disabled = false;
    elements.leadCancelBtn.style.display = "none";
    setLeadStatus("Cancelled");
    elements.leadSummary.textContent = "Search cancelled.";
  } catch (err) {
    console.error("Cancel error:", err);
  }
}

async function exportLeadsCsv() {
  const visibleLeads = applyContactFilter(state.leads);

  if (!visibleLeads.length) return;

  try {
    const result = await window.meetingApp.exportLeadsCsv({ leads: visibleLeads });
    if (result && result.filePath) {
      setLeadStatus("Exported", "success");
      elements.leadSummary.textContent = `CSV exported: ${result.count} leads`;
    }
  } catch (error) {
    setLeadStatus("Export Failed", "error");
    alert(`Could not export CSV:\n\n${error.message || "Unknown error"}`);
  }
}

async function clearLeads() {
  if (!confirm("Clear all saved leads and lead search history?")) return;
  await window.meetingApp.clearLeads();
  state.leads = [];
  state.leadSearches = [];
  renderLeads();
  setLeadStatus("Cleared");
}

function setActiveModule(moduleKey) {
  const isMeeting = moduleKey !== "leads";
  const meetingSections = document.querySelectorAll(".module-meeting");
  const leadSections = document.querySelectorAll(".module-leads");

  meetingSections.forEach((section) => {
    section.style.display = isMeeting ? "" : "none";
  });
  leadSections.forEach((section) => {
    section.style.display = isMeeting ? "none" : "";
  });

  elements.meetingModuleTab.classList.toggle("active", isMeeting);
  elements.leadModuleTab.classList.toggle("active", !isMeeting);
  elements.meetingModuleTab.setAttribute("aria-selected", isMeeting ? "true" : "false");
  elements.leadModuleTab.setAttribute("aria-selected", isMeeting ? "false" : "true");

  localStorage.setItem("activeModule", isMeeting ? "meeting" : "leads");
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
