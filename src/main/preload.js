const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingApp", {
  getState: () => ipcRenderer.invoke("app:getState"),
  saveConfig: (payload) => ipcRenderer.invoke("app:saveConfig", payload),
  chooseAudioFolder: () => ipcRenderer.invoke("app:chooseAudioFolder"),
  uploadExistingAudio: () => ipcRenderer.invoke("app:uploadExistingAudio"),
  importAudio: (payload) => ipcRenderer.invoke("meeting:importAudio", payload),
  createMeeting: (payload) => ipcRenderer.invoke("meeting:create", payload),
  saveRecording: (payload) => ipcRenderer.invoke("meeting:saveRecording", payload),
  deleteSourceRecordings: (meetingId) => ipcRenderer.invoke("meeting:deleteSourceRecordings", meetingId),
  processMeeting: (meetingId) => ipcRenderer.invoke("meeting:process", meetingId),
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
  searchLeadsLocal: (payload) => ipcRenderer.invoke("leads:searchLocal", payload),
  getLeadsState: () => ipcRenderer.invoke("leads:getState"),
  exportLeadsCsv: (payload) => ipcRenderer.invoke("leads:exportCsv", payload),
  clearLeads: () => ipcRenderer.invoke("leads:clear")
});
