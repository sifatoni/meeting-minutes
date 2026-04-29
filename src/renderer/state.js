const state = {
  audioFolder: null,
  aiStatus: "checking", // checking | ready | error
  model: "online", // online | local
  processing: false,
  
  // Existing state fields preserved for functionality
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
  leadDebugMode: false,
  aiReady: false
};

const listeners = [];

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((l) => l(state));
}

export function subscribe(listener) {
  listeners.push(listener);
}
