const fs = require('node:fs');
const path = require('node:path');

const MAX_TAIL = 200;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_NOTABLE_RECORDS = 12;
const MAX_KERNEL_DETAILS_PER_RECORD = 10;
const MAX_KERNEL_DETAILS = 20;
const MAX_UNAVAILABLE_DETAILS = 20;
const MAX_REPORT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_READ_BUDGET_BYTES = 80 * 1024 * 1024;
const LOG_NAMES = ['diagnostics.3.jsonl', 'diagnostics.2.jsonl', 'diagnostics.1.jsonl', 'diagnostics.jsonl'];
const NOTABLE_ISSUE_CATEGORIES = new Map([
  ['parent_heartbeat_missing', 'heartbeat'], ['heartbeat_missing', 'heartbeat'], ['stale_heartbeat', 'heartbeat'],
  ['node_event_loop_delay', 'event_loop'], ['node_eventloop_delay', 'event_loop'],
  ['firmware_flag_current', 'firmware_current'],
  ['network_carrier_lost', 'network_carrier'], ['network_carrier_changes', 'network_carrier'],
  ['network_speed_changed', 'network_carrier'], ['network_counter_increased', 'network_counter'],
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
    else if (argument === '--details') options.details = true;
    else if (argument === '--since') {
      const value = argv[++index];
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(value || '');
      const duration = match ? Number(match[1]) * (match[2] === 'd' ? 86400000 : 3600000) : NaN;
      if (!Number.isFinite(duration) || duration < 1 || duration > MAX_REPORT_RANGE_MS) {
        throw new Error('--since benötigt eine positive Dauer mit h oder d, höchstens 30d (z. B. 48h).');
      }
      options.sinceMs = Math.round(duration);
    }
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
async function readRecentRecords(directory, { tail = 20, onRecord, acceptRecord, maxBytes } = {}) {
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
    throw new Error(`tail muss eine ganze Zahl von 1 bis ${MAX_TAIL} sein.`);
  }
  const result = { records: [], notableRecords: [], filesRead: [], skippedLines: 0, oversizedLines: 0, readErrors: [] };
  if (maxBytes != null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Ungültiges Lesebudget.');
  let bytesRead = 0;
  // Retain one full record per fixed observation category across all stored
  // files. Repeated normal PSI/history flags cannot displace an old failure.
  const latestNotable = new Map();
  for (const name of LOG_NAMES) {
    if (maxBytes != null && bytesRead >= maxBytes) break;
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
            onRecord?.(record);
            if (!acceptRecord || acceptRecord(record)) {
              result.records.push(record);
              if (result.records.length > tail) result.records.shift();
              for (const category of notableCategories(record)) latestNotable.set(category, record);
            }
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
      const streamOptions = { highWaterMark: 64 * 1024 };
      if (maxBytes != null) streamOptions.end = maxBytes - bytesRead - 1;
      for await (const chunk of fs.createReadStream(file, streamOptions)) {
        bytesRead += chunk.length;
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
  if (maxBytes != null) result.readBudget = { maxBytes, bytesRead, exhausted: bytesRead >= maxBytes };
  return result;
}

// Aggregate all valid records inside the requested window while retaining only
// the existing bounded tail/notable lists. API callers keep their tail limit.
async function readReportRange(directory, { sinceMs, untilMs = Date.now(), tail = 20, maxBytes = REPORT_READ_BUDGET_BYTES } = {}) {
  if (!Number.isFinite(sinceMs) || sinceMs < 1 || sinceMs > MAX_REPORT_RANGE_MS || !Number.isFinite(untilMs) ||
      !Number.isFinite(new Date(untilMs).getTime()) || !Number.isFinite(new Date(untilMs - sinceMs).getTime())) {
    throw new Error('Ungültiges Zeitfenster; höchstens 30 Tage sind erlaubt.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > REPORT_READ_BUDGET_BYTES) throw new Error('Ungültiges Lesebudget.');
  const fromMs = untilMs - sinceMs;
  const summary = {
    recordCount: 0, sampleCount: 0, events: {},
    http: { ok: 0, failed: 0, notChecked: 0, maxDurationMs: 0, atLeast500Ms: 0 },
    runtime: { pausesOver500Ms: 0, maxEventLoopDelayMs: 0, maxEventLoopAt: null, maxRssBytes: 0, missingHeartbeats: 0 },
    kernelMessages: 0, maxSampleGapMs: 0, sampleGapsOver120Seconds: 0, sampleClockReversals: 0,
    network: [], networkLimited: false, unavailable: [], unavailableLimited: false,
    resources: { cpuMaxPercent: null, ioWaitMaxPercent: null, memoryMinAvailableBytes: null, swapMaxUsedBytes: null,
      diskMinFreeBytes: null, temperatureMaxCelsius: null, firmwareCheckedSamples: 0, firmwareCurrentSamples: 0, firmwareHistorySamples: 0 },
    processesD: [], processesDLimited: false,
  };
  const network = new Map();
  const unavailable = new Map();
  const processesD = new Map();
  const counterNames = ['rxErrors', 'txErrors', 'rxDropped', 'txDropped', 'rxCrcErrors', 'txCarrierErrors'];
  let storedFrom = Infinity;
  let storedTo = -Infinity;
  let includedFrom = Infinity;
  let includedTo = -Infinity;
  let storedRecordCount = 0;
  let futureRecords = 0;
  let previousSample = null;
  const inWindow = (record) => {
    const timestamp = Date.parse(record.timestamp);
    return timestamp >= fromMs && timestamp <= untilMs;
  };
  const result = await readRecentRecords(directory, { tail, maxBytes, acceptRecord: inWindow, onRecord(record) {
    const timestamp = Date.parse(record.timestamp);
    storedRecordCount += 1;
    storedFrom = Math.min(storedFrom, timestamp);
    storedTo = Math.max(storedTo, timestamp);
    if (timestamp > untilMs) futureRecords += 1;
    if (!inWindow(record)) return;
    summary.recordCount += 1;
    includedFrom = Math.min(includedFrom, timestamp);
    includedTo = Math.max(includedTo, timestamp);
    const event = record.event === 'sample' || Object.hasOwn(EVENT_LABELS, record.event) ? record.event : 'other';
    summary.events[event] = (summary.events[event] || 0) + 1;
    if (record.event !== 'sample') return;
    summary.sampleCount += 1;
    if (previousSample != null) {
      const gap = timestamp - previousSample;
      summary.maxSampleGapMs = Math.max(summary.maxSampleGapMs, gap);
      if (gap > 120000) summary.sampleGapsOver120Seconds += 1;
      if (gap < 0) summary.sampleClockReversals += 1;
    }
    previousSample = timestamp;
    const http = record.http || {};
    summary.http[http.ok === true ? 'ok' : http.ok === false ? 'failed' : 'notChecked'] += 1;
    if (finite(http.durationMs)) {
      summary.http.maxDurationMs = Math.max(summary.http.maxDurationMs, http.durationMs);
      if (http.durationMs >= 500) summary.http.atLeast500Ms += 1;
    }
    const pause = record.runtime?.eventLoop?.maxMs;
    if (finite(pause)) {
      if (pause > 500) summary.runtime.pausesOver500Ms += 1;
      if (pause > summary.runtime.maxEventLoopDelayMs) {
        summary.runtime.maxEventLoopDelayMs = pause;
        summary.runtime.maxEventLoopAt = record.timestamp;
      }
    }
    const rss = record.runtime?.memoryBytes?.rss;
    if (finite(rss)) summary.runtime.maxRssBytes = Math.max(summary.runtime.maxRssBytes, rss);
    if (finite(record.heartbeatAgeMs) && record.heartbeatAgeMs > 15000) summary.runtime.missingHeartbeats += 1;
    const resource = (key, value, minimum = false) => {
      if (!finite(value)) return;
      const previous = summary.resources[key];
      summary.resources[key] = previous == null ? value : minimum ? Math.min(previous, value) : Math.max(previous, value);
    };
    resource('cpuMaxPercent', record.system?.cpu?.usagePercent);
    resource('ioWaitMaxPercent', record.system?.cpu?.ioWaitPercent);
    resource('memoryMinAvailableBytes', record.system?.memory?.availableBytes, true);
    resource('swapMaxUsedBytes', record.system?.memory?.swapUsedBytes);
    resource('diskMinFreeBytes', record.system?.disk?.freeBytes, true);
    for (const zone of Array.isArray(record.system?.thermal) ? record.system.thermal : []) resource('temperatureMaxCelsius', zone?.temperatureCelsius);
    const throttling = record.system?.throttling;
    if (throttling?.current && typeof throttling.current === 'object') {
      summary.resources.firmwareCheckedSamples += 1;
      if (Object.values(throttling.current).some((active) => active === true)) summary.resources.firmwareCurrentSamples += 1;
      if (throttling.occurredSinceBoot && Object.values(throttling.occurredSinceBoot).some((active) => active === true)) summary.resources.firmwareHistorySamples += 1;
    }
    const observedProcesses = relevantDProcesses(record);
    if (observedProcesses.limited) summary.processesDLimited = true;
    for (const [processKey, processInfo] of observedProcesses) {
      const key = `${typeof record.system?.bootId === 'string' ? record.system.bootId.slice(0, 80) : '?'}:${processKey}`;
      if (!processesD.has(key)) {
        if (processesD.size >= 10) {
          const lowest = [...processesD.entries()].sort((first, second) => first[1].observedSamples - second[1].observedSamples)[0];
          processesD.delete(lowest[0]);
          summary.processesDLimited = true;
        }
        processesD.set(key, { pid: processInfo.pid, name: processInfo.name, startTimeTicks: finite(processInfo.startTimeTicks) ? processInfo.startTimeTicks : null,
          observedSamples: 0, firstSeen: record.timestamp, lastSeen: record.timestamp, httpAtLeast500Ms: 0, waitChannel: null });
      }
      const item = processesD.get(key);
      item.observedSamples += 1;
      item.lastSeen = record.timestamp;
      if (finite(http.durationMs) && http.durationMs >= 500) item.httpAtLeast500Ms += 1;
      if (waitChannelSymbol(processInfo.waitChannel)) item.waitChannel = waitChannelSymbol(processInfo.waitChannel);
    }
    for (const group of [record.system?.kernel, record.system?.kernel?.previousBoot]) {
      if (Array.isArray(group?.recentMessages)) summary.kernelMessages += group.recentMessages.length;
    }
    for (const issue of Array.isArray(record.system?.issues) ? record.system.issues : []) {
      if (!issue || typeof issue.interface !== 'string' ||
          !['network_counter_increased', 'network_carrier_changes', 'network_carrier_lost', 'network_speed_changed'].includes(issue.code)) continue;
      const name = displayDetailText(issue.interface, 80);
      if (!network.has(name)) {
        if (network.size >= 8) { summary.networkLimited = true; continue; }
        network.set(name, { interface: name, carrierChanges: 0, carrierChangeSamples: 0, carrierLostSamples: 0, speedChangedSamples: 0, counters: {} });
      }
      const item = network.get(name);
      if (issue.code === 'network_carrier_changes' && finite(issue.delta) && issue.delta > 0) {
        item.carrierChanges += issue.delta;
        item.carrierChangeSamples += 1;
      } else if (issue.code === 'network_carrier_lost') item.carrierLostSamples += 1;
      else if (issue.code === 'network_speed_changed') item.speedChangedSamples += 1;
      else if (issue.code === 'network_counter_increased' && counterNames.includes(issue.counter) && finite(issue.delta) && issue.delta > 0) {
        item.counters[issue.counter] = (item.counters[issue.counter] || 0) + issue.delta;
      }
    }
    for (const item of Array.isArray(record.system?.unavailable) ? record.system.unavailable : []) {
      if (!item || typeof item.source !== 'string') continue;
      const source = displayDetailText(item.source, 80);
      const existing = unavailable.get(source);
      if (existing && existing.timestamp > timestamp) continue;
      unavailable.delete(source);
      unavailable.set(source, { source, reason: typeof item.reason === 'string' ? displayDetailText(item.reason, 80) : 'unbekannt', timestamp });
      if (unavailable.size > MAX_UNAVAILABLE_DETAILS) {
        unavailable.delete(unavailable.keys().next().value);
        summary.unavailableLimited = true;
      }
    }
  } });
  summary.network = [...network.values()];
  summary.unavailable = [...unavailable.values()].map(({ timestamp, ...item }) => ({ ...item, lastSeen: new Date(timestamp).toISOString() }));
  summary.processesD = [...processesD.values()];
  const iso = (value) => Number.isFinite(value) ? new Date(value).toISOString() : null;
  return { ...result, range: {
    requestedFrom: iso(fromMs), requestedTo: iso(untilMs), storedFrom: iso(storedFrom), storedTo: iso(storedTo),
    includedFrom: iso(includedFrom), includedTo: iso(includedTo), storedRecordCount, futureRecords,
    requestedStartReached: storedFrom <= fromMs,
  }, summary };
}

function displayText(value, maxLength = 280) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, maxLength);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function displayDetailText(value, maxLength) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, maxLength);
}

function waitChannelSymbol(value) {
  return typeof value === 'string' && value
    ? displayDetailText(value, 128).replace(/[^A-Za-z0-9_.$:-]/g, '?') : null;
}

function relevantDProcesses(record) {
  const selected = new Map();
  selected.limited = false;
  for (const list of [record.system?.processes?.relevant, record.system?.processes?.topRss]) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || item.state !== 'D' || typeof item.name !== 'string' ||
          !/^(node|nodejs|ffmpeg|mediamtx)$/i.test(item.name) || !Number.isSafeInteger(item.pid) || item.pid < 1) continue;
      const key = `${item.pid}:${finite(item.startTimeTicks) ? item.startTimeTicks : '?'}`;
      if (!selected.has(key) && selected.size >= 10) { selected.limited = true; continue; }
      selected.set(key, item);
    }
  }
  return selected;
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
    const links = system.network.slice(0, 6).filter((link) => link && typeof link.name === 'string').map((link) => {
      const signal = link.carrier === true || link.carrier === 1 ? 'Signal' : link.carrier === false || link.carrier === 0 ? 'kein Signal' : displayText(link.state || 'unbekannt', 30);
      const details = [];
      if (finite(link.speedMbps) && link.speedMbps > 0) details.push(`${link.speedMbps} Mbit/s`);
      if (link.duplex === 'full') details.push('Vollduplex');
      else if (link.duplex === 'half') details.push('Halbduplex');
      return `${displayText(link.name, 40)}=${signal}${details.length ? ` (${details.join(', ')})` : ''}`;
    });
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
  if (issue.code === 'network_carrier_changes') {
    return `LAN-Signalwechsel: ${displayText(issue.interface || '?', 40)}${finite(issue.delta) ? `, ${issue.delta >= 0 ? '+' : ''}${issue.delta} seit letzter Messung` : ''}`;
  }
  if (issue.code === 'network_speed_changed') {
    return `LAN-Geschwindigkeit geändert: ${displayText(issue.interface || '?', 40)}, ${finite(issue.previousMbps) ? issue.previousMbps : '?'} → ${finite(issue.currentMbps) ? issue.currentMbps : '?'} Mbit/s`;
  }
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

function formatReport(result, { directory, details = false, sourceObservations, historyLabel = 'gesamte vorhandene Historie' } = {}) {
  const lines = [];
  const expandedRecords = new Set();
  const displayedWaitChannels = new Set();
  const unavailableSources = new Map();
  let unavailableSourcesLimited = false;
  let kernelDetailsRemaining = MAX_KERNEL_DETAILS;
  let kernelDetailsLimited = false;
  if (details && Array.isArray(sourceObservations)) {
    for (const item of sourceObservations.slice(-MAX_UNAVAILABLE_DETAILS)) {
      if (!item || typeof item.source !== 'string') continue;
      unavailableSources.set(displayDetailText(item.source, 80), {
        reason: typeof item.reason === 'string' ? displayDetailText(item.reason, 80) : 'unbekannt',
        timestamp: Number.isFinite(Date.parse(item.lastSeen)) ? Date.parse(item.lastSeen) : -Infinity,
      });
    }
    unavailableSourcesLimited = sourceObservations.length > MAX_UNAVAILABLE_DETAILS;
  }
  if (directory) lines.push(`Diagnoseverzeichnis: ${displayText(directory, 1000)}`);
  const appendDetails = (record) => {
    if (!details || expandedRecords.has(record)) return;
    expandedRecords.add(record);
    for (const item of Array.isArray(record.system?.unavailable) ? record.system.unavailable : []) {
      if (!item || typeof item.source !== 'string') continue;
      const source = displayDetailText(item.source, 80);
      const reason = typeof item.reason === 'string' ? displayDetailText(item.reason, 80) : 'unbekannt';
      // The same missing source may occur in every sample. Retain its latest
      // reason across the displayed records and print one bounded summary.
      const timestamp = Date.parse(record.timestamp);
      const existing = unavailableSources.get(source);
      if (existing && existing.timestamp > timestamp) continue;
      unavailableSources.delete(source);
      unavailableSources.set(source, { reason, timestamp });
      if (unavailableSources.size > MAX_UNAVAILABLE_DETAILS) {
        unavailableSources.delete(unavailableSources.keys().next().value);
        unavailableSourcesLimited = true;
      }
    }
    for (const item of relevantDProcesses(record).values()) {
      const channel = waitChannelSymbol(item.waitChannel);
      const key = `${item.pid}:${channel}`;
      if (!channel || displayedWaitChannels.has(key) || displayedWaitChannels.size >= 20) continue;
      displayedWaitChannels.add(key);
      lines.push(`  D-Zustand: ${displayText(item.name, 20)} PID ${item.pid}, Wait-Channel ${channel}.`);
    }
    const kernel = record.system?.kernel;
    const selected = [];
    let storedMessages = 0;
    for (const [group, boot] of [[kernel?.previousBoot, 'vorheriger Boot'], [kernel, 'aktueller Boot']]) {
      for (const entry of Array.isArray(group?.recentMessages) ? group.recentMessages : []) {
        if (!entry || typeof entry.message !== 'string') continue;
        storedMessages += 1;
        selected.push({ entry, boot });
        if (selected.length > MAX_KERNEL_DETAILS_PER_RECORD) selected.shift();
      }
    }
    const count = Math.min(selected.length, kernelDetailsRemaining);
    if (!count) {
      if (storedMessages) kernelDetailsLimited = true;
      return;
    }
    for (const { entry, boot } of selected.slice(-count)) {
      const timestamp = typeof entry.timestamp === 'string' ? displayDetailText(entry.timestamp, 80) : 'Zeitpunkt unbekannt';
      lines.push(`  Kernel [${boot}] ${timestamp}: ${displayDetailText(entry.message, 500)}`);
    }
    kernelDetailsRemaining -= count;
    if (storedMessages > count) {
      lines.push(`  ${storedMessages - count} weitere gespeicherte Kernelmeldungen dieses Eintrags nicht angezeigt.`);
      kernelDetailsLimited = true;
    }
    if (kernel?.truncated || kernel?.previousBoot?.truncated) {
      lines.push('  Die Kernel-Erfassung dieses Eintrags war bereits begrenzt.');
    }
  };
  const appendRecord = (record, { includeSystem = true } = {}) => {
    const description = record.event === 'sample'
      ? sampleDescription(record)
      : EVENT_LABELS[record.event] || displayText(record.event);
    const eventDetails = record.event === 'sample' ? '' : record.message || record.error || record.reason || record.signal ||
      (record.event === 'record_truncated' ? `${displayText(record.originalEvent || 'unbekannt')}, ${finite(record.bytes) ? record.bytes : '?'} Bytes` : '');
    const origin = record.event === 'fatal' && record.origin ? ` (${displayText(record.origin, 60)})` : '';
    const kernelCount = Array.isArray(record.system?.kernel?.recentMessages) ? record.system.kernel.recentMessages.length : 0;
    const previousKernelCount = Array.isArray(record.system?.kernel?.previousBoot?.recentMessages) ? record.system.kernel.previousBoot.recentMessages.length : 0;
    const kernelSummary = !includeSystem && (kernelCount || previousKernelCount)
      ? ` | Kernel-Hinweise ${kernelCount}${previousKernelCount ? `, vorheriger Boot ${previousKernelCount}` : ''}` : '';
    lines.push(`${record.timestamp}  ${description}${origin}${eventDetails ? `: ${displayText(typeof eventDetails === 'object' ? JSON.stringify(eventDetails) : eventDetails)}` : ''}${kernelSummary}`);
    const system = includeSystem && record.event === 'sample' && systemDescription(record.system);
    if (system) lines.push(`  System: ${system}`);
    const issues = [...(Array.isArray(record.issues) ? record.issues : []),
      ...(Array.isArray(record.system?.issues) ? record.system.issues : [])];
    const uniqueIssues = [...new Set(issues.map(issueDescription).filter(Boolean))];
    if (uniqueIssues.length) lines.push(`  Beobachtungen: ${uniqueIssues.slice(0, 20).join(', ')}`);
    appendDetails(record);
  };
  if (!result.records.length) {
    lines.push('Keine gültigen Diagnoseeinträge gefunden. Daraus lässt sich kein Betriebszustand ableiten.');
  } else {
    if (result.notableRecords?.length) {
      lines.push(`Letzte gespeicherte Auffälligkeiten (je Kategorie, ${historyLabel}):`);
      for (const record of result.notableRecords) appendRecord(record, { includeSystem: false });
    }
    lines.push(`Letzte ${result.records.length} Einträge (${result.filesRead.length} Dateien gelesen), älteste zuerst:`);
    for (const record of result.records) appendRecord(record);
    lines.push('Messungen und Protokolllücken sind Hinweise; sie belegen allein keine Ausfallursache.');
  }
  if (details && unavailableSources.size) {
    lines.push(sourceObservations
      ? 'Fehlende Messquellen im angeforderten Zeitfenster (jeweils zuletzt beobachteter Grund):'
      : 'Fehlende Messquellen aus den angezeigten Einträgen (jeweils zuletzt beobachteter Grund):');
    for (const [source, { reason }] of unavailableSources) lines.push(`  ${source}: ${reason}`);
    if (unavailableSourcesLimited) lines.push(`Weitere Messquellen nicht angezeigt; die Liste ist auf ${MAX_UNAVAILABLE_DETAILS} Quellen begrenzt.`);
  }
  if (details && kernelDetailsLimited) {
    lines.push(`Kerneldetails sind auf ${MAX_KERNEL_DETAILS_PER_RECORD} Meldungen je Eintrag und ${MAX_KERNEL_DETAILS} insgesamt begrenzt.`);
  }
  if (result.skippedLines) lines.push(`${result.skippedLines} beschädigte/unvollständige Zeilen übersprungen${result.oversizedLines ? `, davon ${result.oversizedLines} über 256 KiB` : ''}.`);
  for (const error of result.readErrors || []) lines.push(`Datei nicht lesbar: ${displayText(error.file)} (${displayText(error.code)}).`);
  return lines.join('\n');
}

function formatRangeReport(result, options = {}) {
  const { range, summary } = result;
  const span = range.includedFrom && range.includedTo
    ? Math.max(0, Math.round((Date.parse(range.includedTo) - Date.parse(range.includedFrom)) / 60000)) : 0;
  const lines = [
    `Gewünschtes Zeitfenster (UTC): ${range.requestedFrom} bis ${range.requestedTo}`,
    `Gelesener Logbestand: ${range.storedFrom || 'keine gültigen Einträge'} bis ${range.storedTo || '—'} (${range.storedRecordCount} Einträge).`,
    `Einträge im Zeitfenster: ${range.includedFrom || 'keine'} bis ${range.includedTo || '—'}; verfügbare Zeitspanne ${Math.floor(span / 60)} h ${span % 60} min.`,
    `Ausgewertet: ${summary.recordCount} Einträge, ${summary.sampleCount} Messungen. HTTP erfolgreich ${summary.http.ok}, fehlgeschlagen ${summary.http.failed}, nicht geprüft ${summary.http.notChecked}; Dauer mindestens 500 ms: ${summary.http.atLeast500Ms}, Maximum ${summary.http.maxDurationMs} ms.`,
    `Messfenster mit Node-Pause über 500 ms: ${summary.runtime.pausesOver500Ms}; Maximum ${summary.runtime.maxEventLoopDelayMs} ms${summary.runtime.maxEventLoopAt ? ` bei ${summary.runtime.maxEventLoopAt}` : ''}; verspätete Heartbeats ${summary.runtime.missingHeartbeats}.`,
    `Größter Abstand zwischen Messungen: ${Math.round(summary.maxSampleGapMs / 1000)} s; Abstände über 120 s: ${summary.sampleGapsOver120Seconds}. Eine Lücke belegt keinen Ausfall.`,
    `Gespeicherte Kernelhinweise: ${summary.kernelMessages}; fehlende Messquellen: ${summary.unavailable.length}${summary.unavailableLimited ? ' (Liste begrenzt)' : ''}.`,
  ];
  if (!range.requestedStartReached) lines.push('Das Zeitfenster beginnt vor den ältesten gelesenen Daten; der angeforderte Zeitraum ist nicht vollständig im gelesenen Logbestand enthalten.');
  if (range.futureRecords) lines.push(`${range.futureRecords} Einträge liegen nach dem Fensterende; Zeitstempel und Systemuhr prüfen.`);
  if (summary.sampleClockReversals) lines.push(`Zeitstempel gingen bei ${summary.sampleClockReversals} Messungen zurück.`);
  const resources = summary.resources;
  const resourceDetails = [];
  if (finite(resources.cpuMaxPercent)) resourceDetails.push(`CPU max. ${resources.cpuMaxPercent.toFixed(1)} %`);
  if (finite(resources.ioWaitMaxPercent)) resourceDetails.push(`I/O-Wartezeit max. ${resources.ioWaitMaxPercent.toFixed(1)} %`);
  if (finite(resources.memoryMinAvailableBytes)) resourceDetails.push(`RAM verfügbar min. ${Math.round(resources.memoryMinAvailableBytes / 1048576)} MiB`);
  if (finite(resources.diskMinFreeBytes)) resourceDetails.push(`Datenträger frei min. ${Math.round(resources.diskMinFreeBytes / 1048576)} MiB`);
  if (finite(resources.temperatureMaxCelsius)) resourceDetails.push(`Temperatur max. ${resources.temperatureMaxCelsius.toFixed(1)} °C`);
  if (resourceDetails.length) lines.push(`Systemwerte im Zeitfenster: ${resourceDetails.join(' | ')}.`);
  if (resources.firmwareCheckedSamples) lines.push(`Aktive Firmwareflags: ${resources.firmwareCurrentSamples} von ${resources.firmwareCheckedSamples} Messungen; historische Flags seit Boot: ${resources.firmwareHistorySamples} Messungen.`);
  for (const item of summary.processesD) {
    lines.push(`D-Zustand ${displayText(item.name, 20)} PID ${item.pid}: ${item.observedSamples} Messungen zwischen ${item.firstSeen} und ${item.lastSeen}; gleichzeitig HTTP mindestens 500 ms: ${item.httpAtLeast500Ms}${options.details && item.waitChannel ? `; letzter Wait-Channel ${item.waitChannel}` : ''}.`);
  }
  if (summary.processesD.length) lines.push('Diese Zeitfenster belegen keine durchgehende D-Dauer und benennen ohne weitere Daten keinen Systemaufruf oder Datenbankfehler.');
  if (summary.processesDLimited) lines.push('D-Prozessliste auf zehn Einträge begrenzt; beibehaltene Prozesszähler können unvollständig sein.');
  for (const item of summary.network) {
    const counters = Object.entries(item.counters).map(([counter, count]) => `${counter} +${count}`);
    lines.push(`Netzwerk ${displayText(item.interface, 80)}: gemeldete Zählerzuwächse; Linkwechsel +${item.carrierChanges} (${item.carrierChangeSamples} Messungen), Linkverlust ${item.carrierLostSamples} Messungen, Geschwindigkeitswechsel ${item.speedChangedSamples} Messungen${counters.length ? `; ${counters.join(', ')}` : ''}.`);
  }
  if (summary.network.length) lines.push('Verwerfungszähler liefern ohne Paketgesamtzahlen keine Verlustquote.');
  if (summary.networkLimited) lines.push('Weitere Netzschnittstellen nicht aggregiert; höchstens acht werden berücksichtigt.');
  const lifecycle = Object.entries(summary.events).filter(([event]) => event !== 'sample').map(([event, count]) => `${displayText(EVENT_LABELS[event] || event)}: ${count}`);
  if (lifecycle.length) lines.push(`Prozessereignisse: ${lifecycle.join(', ')}.`);
  lines.push(`Lesebudget: ${result.readBudget.bytesRead} von ${result.readBudget.maxBytes} Bytes${result.readBudget.exhausted ? ' erreicht; weitere Daten könnten ungelesen sein' : ''}.`);
  lines.push(formatReport(result, { ...options, sourceObservations: summary.unavailable, historyLabel: 'angefordertes Zeitfenster' }));
  return lines.join('\n');
}

module.exports = { MAX_LINE_BYTES, MAX_NOTABLE_RECORDS, REPORT_READ_BUDGET_BYTES, parseCliArgs, resolveDiagnosticsDir, readRecentRecords, readReportRange, formatReport, formatRangeReport };
