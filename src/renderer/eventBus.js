const events = {};

export function emit(event, data) {
  (events[event] || []).forEach(fn => fn(data));
}

export function on(event, fn) {
  if (!events[event]) events[event] = [];
  events[event].push(fn);
}
