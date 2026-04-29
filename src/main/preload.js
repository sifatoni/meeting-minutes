const { contextBridge, ipcRenderer, clipboard } = require("electron");

contextBridge.exposeInMainWorld("meetingApp", {
  getState: () => ipcRenderer.invoke("app:getState"),
  saveConfig: (payload) => ipcRenderer.invoke("app:saveConfig", payload),
  chooseAudioFolder: () => ipcRenderer.invoke("app:chooseAudioFolder"),
  uploadExistingAudio: () => ipcRenderer.invoke("app:uploadExistingAudio"),
  importAudio: (payload) => ipcRenderer.invoke("meeting:importAudio", payload),
  createMeeting: (payload) => ipcRenderer.invoke("meeting:create", payload),
  saveRecording: (payload) => ipcRenderer.invoke("meeting:saveRecording", payload),
  deleteSourceRecordings: (meetingId) => ipcRenderer.invoke("meeting:deleteSourceRecordings", meetingId),
  processMeeting: (meetingId, options) => ipcRenderer.invoke("meeting:process", meetingId, options),
  copyToClipboard: (text) => clipboard.writeText(text),
  updateMinutes: (payload) => ipcRenderer.invoke("meeting:updateMinutes", payload),
  exportDocx: (payload) => ipcRenderer.invoke("meeting:exportDocx", payload),
  clearHistory: () => ipcRenderer.invoke("meeting:clearHistory"),

  // Ollama auto-setup
  checkOllama: () => ipcRenderer.invoke("ollama:check"),
  setupOllama: () => ipcRenderer.invoke("ollama:setup"),
  onOllamaProgress: (callback) => {
    ipcRenderer.removeAllListeners("ollama:progress");
    ipcRenderer.on("ollama:progress", (_event, data) => callback(data));
  },

  // Lead intelligence module
  searchLeads: (payload) => ipcRenderer.invoke("leads:search", payload),
  cancelLeads: () => ipcRenderer.invoke("leads:cancel"),
  getLeadsState: () => ipcRenderer.invoke("leads:getState"),
  exportLeadsCsv: (payload) => ipcRenderer.invoke("leads:exportCsv", payload),
  clearLeads: () => ipcRenderer.invoke("leads:clear"),
  onLeadsProgress: (callback) => {
    ipcRenderer.removeAllListeners("leads:progress");
    ipcRenderer.on("leads:progress", (_event, data) => callback(data));
  },
  onLeadsComplete: (callback) => {
    ipcRenderer.removeAllListeners("leads:complete");
    ipcRenderer.on("leads:complete", (_event, data) => callback(data));
  },
  onLeadsChunk: (callback) => {
    ipcRenderer.removeAllListeners("leads:chunk");
    ipcRenderer.on("leads:chunk", (_event, data) => callback(data));
  },
  onLeadsCaptcha: (callback) => {
    ipcRenderer.removeAllListeners("leads:captcha");
    ipcRenderer.on("leads:captcha", (_event, data) => callback(data));
  },
  onLeadsError: (callback) => {
    ipcRenderer.removeAllListeners("leads:error");
    ipcRenderer.on("leads:error", (_event, data) => callback(data));
  }
});
