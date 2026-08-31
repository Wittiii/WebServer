function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serializeValue(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function readJsonPath(payload, key) {
  if (payload === null || typeof payload !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];

  let current = payload;
  for (const segment of key.split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function extractValue(payload, key) {
  const text = String(payload ?? "").trim();
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey || normalizedKey === "$value") return text;

  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return typeof parsed === "string" ? serializeValue(parsed) : text;
    }

    const jsonValue = readJsonPath(parsed, normalizedKey);
    if (jsonValue !== undefined) return serializeValue(jsonValue);
    return "";
  } catch {
    // Non-JSON payloads continue through the legacy key=value parser.
  }

  const expression = new RegExp(`${escapeRegExp(normalizedKey)}\\s*=\\s*([^,]+)`, "g");
  let match;
  let lastValue = "";
  while ((match = expression.exec(text)) !== null) lastValue = match[1].trim();
  if (lastValue) return lastValue;

  // An exact topic mapping makes a scalar payload unambiguous, so its configured
  // key can be a readable alias such as temperature_c instead of $value.
  return text.includes("=") ? "" : text;
}

function createValueExtractor(payload) {
  const text = String(payload ?? "").trim();
  let parsed;
  let isJson = false;

  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch {
    // Keep legacy scalar and key=value payload handling below.
  }

  return (key) => {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey || normalizedKey === "$value") return text;

    if (isJson) {
      if (parsed === null || typeof parsed !== "object") {
        return typeof parsed === "string" ? serializeValue(parsed) : text;
      }
      const jsonValue = readJsonPath(parsed, normalizedKey);
      return jsonValue === undefined ? "" : serializeValue(jsonValue);
    }

    const expression = new RegExp(`${escapeRegExp(normalizedKey)}\\s*=\\s*([^,]+)`, "g");
    let match;
    let lastValue = "";
    while ((match = expression.exec(text)) !== null) lastValue = match[1].trim();
    if (lastValue) return lastValue;
    return text.includes("=") ? "" : text;
  };
}

module.exports = { createValueExtractor, extractValue, readJsonPath };
