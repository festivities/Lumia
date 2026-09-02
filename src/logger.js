const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function ts() {
  return new Date().toISOString();
}

console.log = function (...args) {
  origLog(`[${ts()}]`, ...args);
};

console.warn = function (...args) {
  origWarn(`[${ts()}]`, ...args);
};

console.error = function (...args) {
  origError(`[${ts()}]`, ...args);
};
