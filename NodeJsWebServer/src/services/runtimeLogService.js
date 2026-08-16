const util = require("util");

const DEFAULT_MAX_ENTRIES = 2000;
const MAX_MESSAGE_LENGTH = 16000;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const entries = [];
const listeners = new Set();
const originalConsoleMethods = new Map();
let nextId = 1;
let installed = false;

function configuredMaxEntries() {
  const value = Number(process.env.RUNTIME_LOG_MAX_ENTRIES || DEFAULT_MAX_ENTRIES);
  return Number.isFinite(value) ? Math.min(20000, Math.max(100, Math.trunc(value))) : DEFAULT_MAX_ENTRIES;
}

function normalizeMessage(args) {
  const formatted = util.format(...args).replace(ANSI_PATTERN, "");
  if (formatted.length <= MAX_MESSAGE_LENGTH) return formatted;
  return `${formatted.slice(0, MAX_MESSAGE_LENGTH)} ... [gekuerzt]`;
}

function append(level, args) {
  const entry = {
    id: nextId,
    timestamp: Date.now(),
    level,
    message: normalizeMessage(args),
  };
  nextId += 1;
  entries.push(entry);

  const overflow = entries.length - configuredMaxEntries();
  if (overflow > 0) entries.splice(0, overflow);

  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A broken browser connection must not affect normal server logging.
    }
  }
}

function installConsoleCapture() {
  if (installed) return;
  installed = true;

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    originalConsoleMethods.set(level, original);
    console[level] = (...args) => {
      original(...args);
      append(level === "log" ? "info" : level, args);
    };
  }
}

function listEntries({ after = 0, limit = 1000 } = {}) {
  const afterId = Math.max(0, Number(after) || 0);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const filtered = entries.filter((entry) => entry.id > afterId);
  return filtered.slice(-safeLimit);
}

function getLastId() {
  return entries.at(-1)?.id || 0;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  getLastId,
  installConsoleCapture,
  listEntries,
  subscribe,
};
