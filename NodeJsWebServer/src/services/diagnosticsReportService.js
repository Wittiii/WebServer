const fs = require('node:fs');
const path = require('node:path');

const MAX_TAIL = 200;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_NOTABLE_RECORDS = 12;
const LOG_NAMES = ['diagnostics.3.jsonl', 'diagnostics.2.jsonl', 'diagnostics.1.jsonl', 'diagnostics.jsonl'];
const NOTABLE_ISSUE_CATEGORIES = new Map([
  ['parent_heartbeat_missing', 'heartbeat'], ['heartbeat_missing', 'heartbeat'], ['stale_heartbeat', 'heartbeat'],
  ['node_event_loop_delay', 'event_loop'], ['node_eventloop_delay', 'event_loop'],
  ['firmware_flag_current', 'firmware_current'],
  ['network_carrier_lost', 'network_carrier'], ['network_counter_increased', 'network_counter'],
  ['low_memory_available', 'low_memory'],
  ['low_disk_space', 'low_disk'], ['disk_inodes_exhausted', 'low_disk'],
  ['cpu_usage_high', 'high_load'], ['io_wait_high', 'high_load'],
]);

function notableCategories(record) {
  if (record.event === 'fatal') return ['fatal'];
  if (record.event === 'parent_disconnect' || record.event === 'monitor_signal') return ['parent_end'];
  if (record.event !== 'sample') return [];
  const categories = new Set();
  if (record.http?.ok === false) categories.add('http_failure');
  if (finite(record.heartbeatAgeMs) && record.heartbeatAgeMs > 15000) categories.add('heartbeat');
  if (finite(record.runtime?.eventLoop?.maxMs) && record.runtime.eventLoop.maxMs > 500) categories.add('event_loop');
  if (record.system?.kernel?.recentMessages?.length || record.system?.kernel?.previousBoot?.recentMessages?.length) {
    categories.add('kernel');
  }
  if (record.system?.throttling?.current && Object.values(record.system.throttling.current).some((active) => active === true)) {
    categories.add('firmware_current');
  }
  for (const issue of [...(Array.isArray(record.issues) ? record.issues : []),
    ...(Array.isArray(record.system?.issues) ? record.system.issues : [])]) {
    const code = typeof issue === 'string' ? issue : issue?.code;
    const category = NOTABLE_ISSUE_CATEGORIES.get(code);
    if (category) categories.add(category);
  }
  return categories;
}

function parseCliArgs(argv) {
  const options = { tail: 20, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--tail') {
      const value = argv[++index];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > MAX_TAIL) {
        throw new Error(`--tail muss eine ganze Zahl von 1 bis ${MAX_TAIL} sein.`);
      }
      options.tail = Number(value);
    } else if (argument === '--dir') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--dir benötigt einen Verzeichnispfad.');
      options.dir = value;
    } else {
      throw new Error(`Unbekanntes Argument: ${argument}`);
    }
  }
  return options;
}

function resolveDiagnosticsDir(env = process.env, cwd = process.cwd()) {
  return env.DIAGNOSTICS_DIR
    ? path.resolve(cwd, env.DIAGNOSTICS_DIR)
    : path.join(__dirname, '..', '..', 'logs', 'diagnostics');
}

// Buffer only one bounded line and the requested tail, including when a damaged
// file contains a very long line without a newline. The database is never opened.
async function readRecentRecords(directory, { tail = 20 } = {}) {
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
    throw new Error(`tail muss eine ganze Zahl von 1 bis ${MAX_TAIL} sein.`);
  }
  const result = { records: [], notableRecords: [], filesRead: [], skippedLines: 0, oversizedLines: 0, readErrors: [] };
  // Retain one full record per fixed observation category across all stored
  // files. Repeated normal PSI/history flags cannot displace an old failure.
  const latestNotable = new Map();
  for (const name of LOG_NAMES) {
    const file = path.join(directory, name);
    let parts = [];
    let lineBytes = 0;
    let oversized = false;
    const acceptPart = (part) => {
      if (oversized) return;
      lineBytes += part.length;
      if (lineBytes > MAX_LINE_BYTES) {
        oversized = true;
        parts = [];
      } else if (part.length) parts.push(part);
    };
    const finishLine = () => {
      if (oversized) {
        result.oversizedLines += 1;
        result.skippedLines += 1;
      } else if (lineBytes) {
        const line = Buffer.concat(parts, lineBytes).toString('utf8').trim();
        if (line) {
          try {
            const record = JSON.parse(line);
            if (!record || Array.isArray(record) || typeof record !== 'object' ||
                typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) ||
                typeof record.event !== 'string' || !record.event) throw new Error('invalid_record');
            result.records.push(record);
            if (result.records.length > tail) result.records.shift();
            for (const category of notableCategories(record)) latestNotable.set(category, record);
          } catch {
            result.skippedLines += 1;
          }
        }
      }
      parts = [];
      lineBytes = 0;
      oversized = false;
    };
    try {
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
        let offset = 0;
        let newline;
        while ((newline = chunk.indexOf(10, offset)) !== -1) {
          acceptPart(chunk.subarray(offset, newline));
          finishLine();
          offset = newline + 1;
        }
        acceptPart(chunk.subarray(offset));
      }
      if (lineBytes || oversized) finishLine();
      result.filesRead.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') result.readErrors.push({ file: name, code: error.code || 'read_failed' });
    }
  }
  result.notableRecords = [...new Set(latestNotable.values())]
    .sort((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp))
    .slice(-MAX_NOTABLE_RECORDS);
  return result;
}

function displayText(value, maxLength = 280) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, maxLength);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sampleDescription(record) {
  const parts = [];
  if (record.http?.ok === true) {
    parts.push(`HTTP antwortet${finite(record.http.statusCode) ? ` (${record.http.statusCode})` : ''}`);
  } else if (record.http?.ok === false) {
    parts.push(`HTTP-Prüfung fehlgeschlagen${record.http.error ? ` (${displayText(record.http.error)})` : ''}`);
  } else {
    parts.push('HTTP nicht geprüft');
  }
  if (finite(record.http?.durationMs)) parts.push(`HTTP ${Math.round(record.http.durationMs)} ms`);
  if (finite(record.heartbeatAgeMs)) parts.push(`Heartbeat ${Math.round(record.heartbeatAgeMs / 1000)} s alt`);
  if (finite(record.runtime?.memoryBytes?.rss)) parts.push(`Node-RSS ${Math.round(record.runtime.memoryBytes.rss / 1048576)} MiB`);
  if (finite(record.runtime?.eventLoop?.maxMs)) parts.push(`Node-Pause max. ${record.runtime.eventLoop.maxMs} ms`);
  return parts.join(' | ');
}

function systemDescription(system) {
  if (!system || typeof system !== 'object') return '';
  const parts = [];
  if (finite(system.cpu?.usagePercent)) parts.push(`CPU ${system.cpu.usagePercent.toFixed(1)} %`);
  if (finite(system.cpu?.ioWaitPercent)) parts.push(`I/O-Wartezeit ${system.cpu.ioWaitPercent.toFixed(1)} %`);
  if (finite(system.memory?.availableBytes)) parts.push(`RAM verfügbar ${Math.round(system.memory.availableBytes / 1048576)} MiB`);
  if (finite(system.memory?.swapUsedBytes)) parts.push(`Swap belegt ${Math.round(system.memory.swapUsedBytes / 1048576)} MiB`);
  if (finite(system.disk?.freeBytes)) parts.push(`Datenträger frei ${Math.round(system.disk.freeBytes / 1048576)} MiB`);
  const temperatures = Array.isArray(system.thermal)
    ? system.thermal.map((zone) => zone?.temperatureCelsius).filter(finite) : [];
  if (temperatures.length) parts.push(`Temperatur max. ${temperatures.reduce((maximum, value) => Math.max(maximum, value), -Infinity).toFixed(1)} °C`);
  if (system.throttling?.raw) parts.push(`Firmware-Flags ${displayText(system.throttling.raw, 40)}`);
  if (Array.isArray(system.network)) {
    const links = system.network.slice(0, 6).filter((link) => link && typeof link.name === 'string').map((link) =>
      `${displayText(link.name, 40)}=${link.carrier === true || link.carrier === 1 ? 'Signal' : link.carrier === false || link.carrier === 0 ? 'kein Signal' : displayText(link.state || 'unbekannt', 30)}`);
    if (links.length) parts.push(`LAN/Netz ${links.join(', ')}`);
  }
  if (Array.isArray(system.kernel?.recentMessages) && system.kernel.recentMessages.length) {
    parts.push(`Kernel-Hinweise ${system.kernel.recentMessages.length}`);
  }
  if (Array.isArray(system.unavailable) && system.unavailable.length) parts.push(`${system.unavailable.length} Messquellen nicht verfügbar`);
  return parts.join(' | ');
}

function issueDescription(issue) {
  if (typeof issue === 'string') return displayText(issue);
  if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string') return null;
  const details = ['flag', 'resource', 'scope', 'avg10Percent', 'interface', 'counter', 'delta', 'usagePercent', 'ioWaitPercent']
    .filter((key) => typeof issue[key] === 'string' || finite(issue[key]))
    .map((key) => `${key}=${displayText(issue[key], 60)}`);
  return `${displayText(issue.code, 100)}${details.length ? ` [${details.join(', ')}]` : ''}`;
}

const EVENT_LABELS = {
  monitor_start: 'Diagnoseprozess gestartet',
  server_starting: 'Webserver startet',
  server_ready: 'Webserver bereit',
  server_stopping: 'Webserver wird gestoppt',
  server_stopped: 'Webserver gestoppt',
  parent_disconnect: 'Verbindung zum Webserverprozess beendet',
  fatal: 'Fataler Fehler gemeldet',
  monitor_error: 'Diagnosefehler gemeldet',
  monitor_signal: 'Diagnoseprozess erhielt ein Signal',
  record_truncated: 'Diagnoseeintrag überschritt die Größenbegrenzung',
};

function formatReport(result, { directory } = {}) {
  const lines = [];
  if (directory) lines.push(`Diagnoseverzeichnis: ${displayText(directory, 1000)}`);
  const appendRecord = (record, { includeSystem = true } = {}) => {
    const description = record.event === 'sample'
      ? sampleDescription(record)
      : EVENT_LABELS[record.event] || displayText(record.event);
    const details = record.event === 'sample' ? '' : record.message || record.error || record.reason || record.signal ||
      (record.event === 'record_truncated' ? `${displayText(record.originalEvent || 'unbekannt')}, ${finite(record.bytes) ? record.bytes : '?'} Bytes` : '');
    const origin = record.event === 'fatal' && record.origin ? ` (${displayText(record.origin, 60)})` : '';
    const kernelCount = Array.isArray(record.system?.kernel?.recentMessages) ? record.system.kernel.recentMessages.length : 0;
    const previousKernelCount = Array.isArray(record.system?.kernel?.previousBoot?.recentMessages) ? record.system.kernel.previousBoot.recentMessages.length : 0;
    const kernelSummary = !includeSystem && (kernelCount || previousKernelCount)
      ? ` | Kernel-Hinweise ${kernelCount}${previousKernelCount ? `, vorheriger Boot ${previousKernelCount}` : ''}` : '';
    lines.push(`${record.timestamp}  ${description}${origin}${details ? `: ${displayText(typeof details === 'object' ? JSON.stringify(details) : details)}` : ''}${kernelSummary}`);
    const system = includeSystem && record.event === 'sample' && systemDescription(record.system);
    if (system) lines.push(`  System: ${system}`);
    const issues = [...(Array.isArray(record.issues) ? record.issues : []),
      ...(Array.isArray(record.system?.issues) ? record.system.issues : [])];
    const uniqueIssues = [...new Set(issues.map(issueDescription).filter(Boolean))];
    if (uniqueIssues.length) lines.push(`  Beobachtungen: ${uniqueIssues.slice(0, 20).join(', ')}`);
  };
  if (!result.records.length) {
    lines.push('Keine gültigen Diagnoseeinträge gefunden. Daraus lässt sich kein Betriebszustand ableiten.');
  } else {
    if (result.notableRecords?.length) {
      lines.push('Letzte gespeicherte Auffälligkeiten (je Kategorie, gesamte vorhandene Historie):');
      for (const record of result.notableRecords) appendRecord(record, { includeSystem: false });
    }
    lines.push(`Letzte ${result.records.length} Einträge (${result.filesRead.length} Dateien gelesen), älteste zuerst:`);
    for (const record of result.records) appendRecord(record);
    lines.push('Messungen und Protokolllücken sind Hinweise; sie belegen allein keine Ausfallursache.');
  }
  if (result.skippedLines) lines.push(`${result.skippedLines} beschädigte/unvollständige Zeilen übersprungen${result.oversizedLines ? `, davon ${result.oversizedLines} über 256 KiB` : ''}.`);
  for (const error of result.readErrors || []) lines.push(`Datei nicht lesbar: ${displayText(error.file)} (${displayText(error.code)}).`);
  return lines.join('\n');
}

module.exports = { MAX_LINE_BYTES, MAX_NOTABLE_RECORDS, parseCliArgs, resolveDiagnosticsDir, readRecentRecords, formatReport };
