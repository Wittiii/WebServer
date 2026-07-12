export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTimestamp(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function normalizeFieldValue(value, field = {}) {
  if (field.type === "checkbox") return Boolean(value);
  if (value == null || value === "") return "";
  if (field.type === "number" || field.type === "select") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : String(value).trim();
  }
  return String(value).trim();
}

export function setStatusLine(element, text, isError = false) {
  if (!element) return;
  element.textContent = text;
  element.style.color = isError ? "#f87171" : "#38bdf8";
}
