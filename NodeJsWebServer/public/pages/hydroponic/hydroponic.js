// MQTT (manuell)
const form = document.getElementById('mqtt-form');
const topicInput = document.getElementById('mqtt-topic');
const payloadInput = document.getElementById('mqtt-payload');
const statusEl = document.getElementById('mqtt-status');
const sendBtn = document.getElementById('mqtt-send');

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? 'crimson' : 'green';
}
async function publishMqtt(topic, payload) {
  const res = await fetch('/api/mqtt/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(data.error || 'Publish fehlgeschlagen');
  }
}


async function loadReadings() {
  if (!readingsList) return;

  const obj = getSelectedObject();
  if (!obj) {
    readingsList.innerHTML = '<li>Kein Objekt ausgewählt</li>';
    drawChart([]);
    lastReadingsCache = [];
    chartDataCache = [];
    chartHoverIndex = null;
    return;
  }

  readingsList.innerHTML = '<li>Lade ...</li>';
  try {
    const key = getSelectedKey();
    const range = getDateRange();
    const params = new URLSearchParams();
    params.set('limit', '0');
    if (key) params.set('key', key);
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const url = `/api/objects/${obj.id}/readings?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fehler beim Laden');
    const list = await res.json();

    if (!Array.isArray(list) || list.length === 0) {
      readingsList.innerHTML = '<li>Keine Messwerte vorhanden</li>';
      drawChart([]);
      lastReadingsCache = [];
      chartDataCache = [];
      chartHoverIndex = null;
      return;
    }

    readingsList.innerHTML = list.map((r) => {
      const ts = r.created_at ? new Date(r.created_at).toLocaleString() : '-';
      const topic = r.topic ? `Topic: ${escapeHtml(r.topic)} - ` : '';
      const key = r.value_key ? `${escapeHtml(r.value_key)} = ` : '';
      const unit = r.value_key ? getUnitForKey(r.value_key) : '';
      const val = escapeHtml(r.value_text ?? '');
      const valWithUnit = unit ? `${val} ${escapeHtml(unit)}` : val;
      return `<li>${ts} - ${topic}${key}${valWithUnit}</li>`;
    }).join('');

    const ordered = list.slice().reverse();
    chartDataCache = ordered;
    chartHoverIndex = null;
    drawChart(ordered);
    lastReadingsCache = list;
    checkThresholds(list);
  } catch (err) {
    readingsList.innerHTML = `<li>Fehler: ${err.message || err}</li>`;
    drawChart([]);
    lastReadingsCache = [];
    chartDataCache = [];
    chartHoverIndex = null;
  }
}

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const topic = topicInput?.value.trim() || '';
    const payload = payloadInput?.value ?? '';

    if (!topic) {
      setStatus('Topic fehlt.', true);
      return;
    }

    if (sendBtn) sendBtn.disabled = true;
    setStatus('Sende...');

    try {
      await publishMqtt(topic, payload);
      setStatus('Gesendet.');
    } catch (err) {
      setStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  });
}

// Objects (DB)
const objectForm = document.getElementById('object-form');
const objectName = document.getElementById('object-name');
const objectCreate = document.getElementById('object-create');
const objectRefresh = document.getElementById('object-refresh');
const objectStatus = document.getElementById('object-status');
const objectList = document.getElementById('object-list');
const brokerSummary = document.getElementById('broker-summary');
const thresholdMin = document.getElementById('threshold-min');
const thresholdMax = document.getElementById('threshold-max');
const thresholdSave = document.getElementById('threshold-save');
const thresholdStatus = document.getElementById('threshold-status');

// Object config
const objectSelect = document.getElementById('object-select');
const commandForm = document.getElementById('command-form');
const commandLabel = document.getElementById('command-label');
const commandPayload = document.getElementById('command-payload');
const commandTopic = document.getElementById('command-topic');
const commandAdd = document.getElementById('command-add');
const commandList = document.getElementById('command-list');
const commandCancel = document.getElementById('command-cancel');
const configStatus = document.getElementById('object-config-status');
const keyForm = document.getElementById('key-form');
const keyIdInput = document.getElementById('key-id');
const keyInput = document.getElementById('key-input');
const keyTopic = document.getElementById('key-topic');
const keyLabel = document.getElementById('key-label');
const keyUnit = document.getElementById('key-unit');
const keySave = document.getElementById('key-save');
const keyCancel = document.getElementById('key-cancel');
const keyList = document.getElementById('key-list');
const keySelect = document.getElementById('key-select');
const graphRefresh = document.getElementById('graph-refresh');
const exportCsvBtn = document.getElementById('export-csv');
const chartCanvas = document.getElementById('readings-chart');
const dateFrom = document.getElementById('date-from');
const dateTo = document.getElementById('date-to');
const autoRefreshToggle = document.getElementById('auto-refresh');
const autoRefreshSec = document.getElementById('auto-refresh-sec');
const readingsRefresh = document.getElementById('readings-refresh');
const deleteReadingsBtn = document.getElementById('delete-readings');
const optimizeDatabaseBtn = document.getElementById('optimize-database');
const readingsStatus = document.getElementById('readings-status');
const databaseStorageStatus = document.getElementById('database-storage-status');
const readingsList = document.getElementById('readings-list');
const automationForm = document.getElementById('automation-form');
const automationIdInput = document.getElementById('automation-id');
const automationNameInput = document.getElementById('automation-name');
const automationTriggerType = document.getElementById('automation-trigger-type');
const automationEnabled = document.getElementById('automation-enabled');
const automationValueFields = document.getElementById('automation-value-fields');
const automationKeySelect = document.getElementById('automation-key');
const automationOperator = document.getElementById('automation-operator');
const automationCompareInput = document.getElementById('automation-compare');
const automationHysteresisInput = document.getElementById('automation-hysteresis');
const automationTimeFields = document.getElementById('automation-time-fields');
const automationTimeInput = document.getElementById('automation-time');
const automationWeekdayInputs = Array.from(document.querySelectorAll('input[name="automation-weekday"]'));
const automationWindowStartInput = document.getElementById('automation-window-start');
const automationWindowEndInput = document.getElementById('automation-window-end');
const automationCooldownInput = document.getElementById('automation-cooldown');
const automationActionType = document.getElementById('automation-action-type');
const automationCommandFields = document.getElementById('automation-command-fields');
const automationCommandSelect = document.getElementById('automation-command');
const automationCustomFields = document.getElementById('automation-custom-fields');
const automationTopicInput = document.getElementById('automation-topic');
const automationPayloadInput = document.getElementById('automation-payload');
const automationActionAdd = document.getElementById('automation-action-add');
const automationActionList = document.getElementById('automation-action-list');
const automationCancel = document.getElementById('automation-cancel');
const automationStatus = document.getElementById('automation-status');
const automationList = document.getElementById('automation-list');

let objectsCache = [];
let keysCache = [];
let lastReadingsCache = [];
let chartMeta = null;
let chartTooltip = null;
let chartHoverIndex = null;
let chartDataCache = [];
let autoRefreshTimer = null;
const GRAPH_LIMIT = 1000;
const GRAPH_TAIL = GRAPH_LIMIT;
let currentCommands = [];
let topicsCache = [];
let editingCommandIndex = null;
let automationRulesCache = [];
let automationDraftActions = [];
const AUTOMATION_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const AUTOMATION_WEEKDAY_LABELS = {
  0: 'So',
  1: 'Mo',
  2: 'Di',
  3: 'Mi',
  4: 'Do',
  5: 'Fr',
  6: 'Sa'
};

function setObjectStatus(text, isError = false) {
  if (!objectStatus) return;
  objectStatus.textContent = text;
  objectStatus.style.color = isError ? 'crimson' : 'green';
}

function setConfigStatus(text, isError = false) {
  if (!configStatus) return;
  configStatus.textContent = text;
  configStatus.style.color = isError ? 'crimson' : 'green';
}

function setReadingsStatus(text, isError = false) {
  if (!readingsStatus) return;
  readingsStatus.textContent = text;
  readingsStatus.style.color = isError ? 'crimson' : 'green';
}

function setAutomationStatus(text, isError = false) {
  if (!automationStatus) return;
  automationStatus.textContent = text;
  automationStatus.style.color = isError ? 'crimson' : 'green';
}

function getThresholdKey() {
  const obj = getSelectedObject();
  const key = getSelectedKey();
  if (!obj || !key) return null;
  return `hydro-threshold-${obj.id}-${key}`;
}

function loadThresholdSettings() {
  const storageKey = getThresholdKey();
  if (!storageKey) return { min: null, max: null };
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return { min: null, max: null };
    const parsed = JSON.parse(stored);
    return { min: parsed.min ?? null, max: parsed.max ?? null };
  } catch {
    return { min: null, max: null };
  }
}

function saveThresholdSettings() {
  const storageKey = getThresholdKey();
  if (!storageKey) return;
  const minValue = thresholdMin?.value.trim();
  const maxValue = thresholdMax?.value.trim();
  const payload = {
    min: minValue === '' ? null : parseFloat(minValue.replace(',', '.')),
    max: maxValue === '' ? null : parseFloat(maxValue.replace(',', '.'))
  };
  localStorage.setItem(storageKey, JSON.stringify(payload));
  displayThresholdStatus(payload);
  setReadingsStatus('Schwellenwerte gespeichert.');
}

function displayThresholdStatus(payload) {
  if (!thresholdStatus) return;
  const min = payload?.min;
  const max = payload?.max;
  if (min === null && max === null) {
    thresholdStatus.textContent = 'Noch keine Grenzwerte gesetzt.';
    thresholdStatus.style.color = 'var(--text-muted)';
    thresholdStatus.style.background = 'rgba(255,255,255,0.04)';
    return;
  }

  const parts = [];
  if (min !== null) parts.push(`Min: ${min}`);
  if (max !== null) parts.push(`Max: ${max}`);
  thresholdStatus.textContent = `Gesetzt: ${parts.join(' / ')}`;
  thresholdStatus.style.color = 'var(--accent)';
  thresholdStatus.style.background = 'rgba(56, 189, 248, 0.08)';
}

function checkThresholds(readings) {
  if (!thresholdStatus) return;
  const { min, max } = loadThresholdSettings();
  const valueKey = getSelectedKey();
  if ((!Number.isFinite(min) && !Number.isFinite(max)) || !valueKey) {
    displayThresholdStatus({ min, max });
    return;
  }

  const violations = readings
    .map((r) => ({
      value: parseNumber(r.value_text),
      ts: r.created_at,
      topic: r.topic,
      key: r.value_key
    }))
    .filter((row) => Number.isFinite(row.value))
    .filter((row) => (Number.isFinite(min) && row.value < min) || (Number.isFinite(max) && row.value > max));

  if (violations.length === 0) {
    displayThresholdStatus({ min, max });
    thresholdStatus.textContent = `Ok: Keine Abweichungen`;
    thresholdStatus.style.color = 'var(--success)';
    thresholdStatus.style.background = 'rgba(16, 185, 129, 0.08)';
    return;
  }

  const first = violations[0];
  thresholdStatus.textContent = `Alarm: ${violations.length} Abweichung(en), zuletzt ${first.value} ${getSelectedKeyUnit()} um ${new Date(first.ts).toLocaleString()}`;
  thresholdStatus.style.color = 'var(--danger)';
  thresholdStatus.style.background = 'rgba(239, 68, 68, 0.12)';
}

function populateThresholdInputs() {
  if (!thresholdMin || !thresholdMax) return;
  const settings = loadThresholdSettings();
  thresholdMin.value = Number.isFinite(settings.min) ? settings.min : '';
  thresholdMax.value = Number.isFinite(settings.max) ? settings.max : '';
  displayThresholdStatus(settings);
}

async function loadHydroponicBrokerSummary() {
  if (!brokerSummary) return;
  try {
    const [clients, topics] = await Promise.all([
      fetch('/api/mqtt/clients').then((res) => res.json()),
      fetch('/api/mqtt/topics').then((res) => res.json())
    ]);
    const online = Array.isArray(clients) ? clients.filter((c) => c.connected).length : 0;
    const topicCount = Array.isArray(topics) ? topics.length : 0;
    brokerSummary.innerHTML = `
      <div class="stats-card">
        <h3>MQTT Broker</h3>
        <div class="stats-val">${online > 0 ? 'ONLINE' : 'OFFLINE'}</div>
        <p>${online} aktive Clients</p>
      </div>
      <div class="stats-card">
        <h3>Topics</h3>
        <div class="stats-val">${topicCount}</div>
        <p>Empfangene Topics</p>
      </div>
    `;
  } catch (err) {
    if (brokerSummary) {
      brokerSummary.innerHTML = '<div class="error-msg">MQTT-Status konnte nicht geladen werden.</div>';
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toIso(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function getDateRange() {
  return {
    from: toIso(dateFrom?.value),
    to: toIso(dateTo?.value)
  };
}

function buildCsv(readings) {
  const header = ['created_at', 'topic', 'value_key', 'value_text', 'raw_payload'];
  const lines = [header.join(',')];
  for (const r of readings) {
    const row = [
      r.created_at,
      r.topic,
      r.value_key,
      r.value_text,
      r.raw_payload
    ].map((v) => {
      const s = String(v ?? '');
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    });
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function downloadCsv(readings) {
  if (!Array.isArray(readings) || readings.length === 0) return;
  const csv = buildCsv(readings);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const obj = getSelectedObject();
  const key = getSelectedKey() || 'all';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `readings_${obj?.id || 'obj'}_${key}_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function startAutoRefresh() {
  stopAutoRefresh();
  const sec = Number(autoRefreshSec?.value) || 10;
  const ms = Math.min(Math.max(sec, 2), 300) * 1000;
  autoRefreshTimer = setInterval(() => {
    loadReadings();
  }, ms);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function setupAutoRefresh() {
  if (autoRefreshToggle?.checked) startAutoRefresh();
  else stopAutoRefresh();
}

function getChartTooltip() {
  if (chartTooltip) return chartTooltip;
  const el = document.createElement('div');
  el.className = 'chart-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  chartTooltip = el;
  return el;
}

function hideChartTooltip() {
  const el = getChartTooltip();
  el.style.display = 'none';
}

function findNearestIndex(idx, values) {
  if (!Array.isArray(values) || values.length === 0) return -1;
  if (Number.isFinite(values[idx])) return idx;
  for (let d = 1; d < values.length; d++) {
    const left = idx - d;
    const right = idx + d;
    if (left >= 0 && Number.isFinite(values[left])) return left;
    if (right < values.length && Number.isFinite(values[right])) return right;
  }
  return -1;
}

function parseNumber(valueText) {
  const num = parseFloat(String(valueText ?? '').replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function buildDrawIndices(valuesByIndex, maxPoints) {
  const n = valuesByIndex.length;
  if (n === 0) return [];
  const numericCount = valuesByIndex.filter((v) => Number.isFinite(v)).length;
  if (numericCount === 0) return [];
  if (n <= maxPoints) {
    return valuesByIndex
      .map((v, i) => (Number.isFinite(v) ? i : null))
      .filter((v) => v !== null);
  }

  const bucketSize = Math.ceil(n / maxPoints);
  const indices = [];
  for (let start = 0; start < n; start += bucketSize) {
    let minVal = Infinity;
    let maxVal = -Infinity;
    let minIdx = -1;
    let maxIdx = -1;
    const end = Math.min(n, start + bucketSize);
    for (let i = start; i < end; i++) {
      const v = valuesByIndex[i];
      if (!Number.isFinite(v)) continue;
      if (v < minVal) {
        minVal = v;
        minIdx = i;
      }
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    }
    if (minIdx >= 0) indices.push(minIdx);
    if (maxIdx >= 0 && maxIdx !== minIdx) indices.push(maxIdx);
  }
  indices.sort((a, b) => a - b);
  return indices;
}

function buildDrawIndicesWithTail(valuesByIndex, maxPoints, tailCount) {
  const n = valuesByIndex.length;
  if (n === 0) return { head: [], tail: [], tailStart: 0 };

  const tailStart = Math.max(0, n - tailCount);
  const tailIndices = [];
  for (let i = tailStart; i < n; i++) {
    if (Number.isFinite(valuesByIndex[i])) tailIndices.push(i);
  }

  const headMax = Math.max(0, maxPoints - tailIndices.length);
  const headIndices = headMax > 0 ? buildDrawIndices(valuesByIndex.slice(0, tailStart), headMax) : [];
  return { head: headIndices, tail: tailIndices, tailStart };
}

function computeMedian(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function computeRegression(valuesByIndex) {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < valuesByIndex.length; i++) {
    const v = valuesByIndex[i];
    if (!Number.isFinite(v)) continue;
    n++;
    sumX += i;
    sumY += v;
    sumXY += i * v;
    sumXX += i * i;
  }
  if (n < 2) return null;
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const m = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - m * sumX) / n;
  return { m, b };
}

function prepareCanvas() {
  if (!chartCanvas) return null;
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = chartCanvas.clientWidth || 900;
  const cssHeight = chartCanvas.clientHeight || 260;
  chartCanvas.width = Math.floor(cssWidth * ratio);
  chartCanvas.height = Math.floor(cssHeight * ratio);
  const ctx = chartCanvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: cssWidth, h: cssHeight };
}

function drawChart(readings) {
  const canvas = prepareCanvas();
  if (!canvas) return;
  const { ctx, w, h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const unit = getSelectedKeyUnit();

  if (!Array.isArray(readings) || readings.length === 0) {
    chartMeta = null;
    hideChartTooltip();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Keine Daten', 12, 20);
    return;
  }

  const valuesByIndex = readings.map((r) => parseNumber(r.value_text));
  const points = valuesByIndex.map((v, i) => (v === null ? null : { x: i, y: v }));
  const values = valuesByIndex.filter((v) => Number.isFinite(v));

  if (values.length === 0) {
    chartMeta = null;
    hideChartTooltip();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Keine numerischen Werte', 12, 20);
    return;
  }

  let min = Math.min(...values);
  let max = Math.max(...values);
  const range = max - min || 1;
  const padVal = range * 0.05;
  min -= padVal;
  max += padVal;
  const pad = 36;
  const span = max - min || 1;
  const xSpan = readings.length - 1 || 1;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = computeMedian(values);
  const headBudget = Math.max(200, Math.floor(w));
  const maxPoints = GRAPH_TAIL + headBudget;
  const draw = buildDrawIndicesWithTail(valuesByIndex, maxPoints, GRAPH_TAIL);
  chartMeta = { readings, valuesByIndex, min, max, span, pad, w, h, unit, draw };

  // Axis
  ctx.strokeStyle = 'rgba(148,163,184,0.4)';
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  // Y ticks and labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px system-ui, sans-serif';
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const v = max - t * span;
    const y = pad + t * (h - pad * 2);
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
    const label = unit ? `${v.toFixed(2)} ${unit}` : v.toFixed(2);
    ctx.fillText(label, 6, y + 4);
  }

  // X labels: choose up to 4 evenly spaced points
  const len = readings.length;
  const targetLabels = Math.min(4, len);
  const idxs = [];
  if (targetLabels <= 1) {
    idxs.push(0);
  } else {
    for (let i = 0; i < targetLabels; i++) {
      idxs.push(Math.floor((len - 1) * (i / (targetLabels - 1))));
    }
  }
  const labelFont = '12px system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.font = labelFont;
  ctx.textAlign = 'center';
  idxs.forEach((i) => {
    const x = pad + (i / xSpan) * (w - pad * 2);
    const ts = readings[i]?.created_at ? new Date(readings[i].created_at) : null;
    let label;
    if (ts) {
      const time = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = ts.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
      label = i === 0 || i === len - 1 ? `${time}
${date}` : time;
    } else {
      label = String(i);
    }
    const lines = label.split('\n');
    lines.forEach((line, lineIndex) => {
      ctx.fillText(line, x, h - 12 + lineIndex * 14);
    });
  });
  ctx.textAlign = 'left';

  // Line
  const drawLine = (indices, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    indices.forEach((idx) => {
      const v = valuesByIndex[idx];
      if (!Number.isFinite(v)) {
        started = false;
        return;
      }
      const x = pad + (idx / xSpan) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };

  // Head (approximated) line
  drawLine(chartMeta.draw.head, '#3b82f6');
  // Tail (last 1000) exact line
  drawLine(chartMeta.draw.tail, '#22d3ee');

  // Mean line
  if (Number.isFinite(mean)) {
    const y = h - pad - ((mean - min) / span) * (h - pad * 2);
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
    ctx.fillStyle = '#22c55e';
    const label = unit ? `Mittel: ${mean.toFixed(2)} ${unit}` : `Mittel: ${mean.toFixed(2)}`;
    ctx.fillText(label, w - pad - 150, y - 4);
  }

  // Median line
  if (Number.isFinite(median)) {
    const y = h - pad - ((median - min) / span) * (h - pad * 2);
    ctx.strokeStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
    ctx.fillStyle = '#f59e0b';
    const label = unit ? `Median: ${median.toFixed(2)} ${unit}` : `Median: ${median.toFixed(2)}`;
    ctx.fillText(label, w - pad - 150, y + 14);
  }

  // Regression line (Trend)
  const reg = computeRegression(valuesByIndex);
  if (reg) {
    const y0 = reg.m * 0 + reg.b;
    const y1 = reg.m * (readings.length - 1) + reg.b;
    const x0 = pad;
    const x1 = w - pad;
    const cy0 = h - pad - ((y0 - min) / span) * (h - pad * 2);
    const cy1 = h - pad - ((y1 - min) / span) * (h - pad * 2);
    ctx.strokeStyle = '#a855f7';
    ctx.beginPath();
    ctx.moveTo(x0, cy0);
    ctx.lineTo(x1, cy1);
    ctx.stroke();
    ctx.fillStyle = '#a855f7';
    ctx.fillText('Trend', w - pad - 60, pad + 12);
  }

  if (chartHoverIndex !== null) {
    const idx = findNearestIndex(chartHoverIndex, valuesByIndex);
    if (idx >= 0 && Number.isFinite(valuesByIndex[idx])) {
      const x = pad + (idx / xSpan) * (w - pad * 2);
      const y = h - pad - ((valuesByIndex[idx] - min) / span) * (h - pad * 2);
      ctx.strokeStyle = 'rgba(56,189,248,0.6)';
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, h - pad);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function renderKeyList(list) {
  if (!keyList) return;
  if (!list.length) {
    keyList.innerHTML = '<li>Keine Keys definiert</li>';
    return;
  }

  keyList.innerHTML = list.map((k) => {
    const topic = k.topic ? ` [${escapeHtml(k.topic)}]` : '';
    const label = k.label ? ` (${escapeHtml(k.label)})` : '';
    const unit = k.unit ? ` [${escapeHtml(k.unit)}]` : '';
    return `
      <li data-id="${k.id}">
        <span class="key-name">${escapeHtml(k.value_key)}${topic}${label}${unit}</span>
        <button class="key-edit" type="button">Bearbeiten</button>
        <button class="key-delete" type="button">Loeschen</button>
      </li>
    `;
  }).join('');
}

function renderKeySelect(list, selectedKey) {
  if (!keySelect) return;
  if (!list.length) {
    keySelect.innerHTML = '';
    return;
  }
  keySelect.innerHTML = list.map((k) => {
    const sel = k.value_key === selectedKey ? 'selected' : '';
    const topic = k.topic ? ` [${escapeHtml(k.topic)}]` : '';
    const label = k.label ? ` (${escapeHtml(k.label)})` : '';
    const unit = k.unit ? ` [${escapeHtml(k.unit)}]` : '';
    return `<option value="${escapeHtml(k.value_key)}" ${sel}>${escapeHtml(k.value_key + topic + label + unit)}</option>`;
  }).join('');
}

function getSelectedKey() {
  return keySelect?.value || '';
}

function getSelectedKeyMeta() {
  const key = getSelectedKey();
  return keysCache.find((k) => k.value_key === key) || null;
}

function getSelectedKeyUnit() {
  return getSelectedKeyMeta()?.unit || '';
}

function getUnitForKey(key) {
  return keysCache.find((k) => k.value_key === key)?.unit || '';
}

function setKeyFormMode(editing, keyObj) {
  if (keySave) keySave.textContent = editing ? 'Speichern' : 'Hinzufuegen';
  if (keyCancel) keyCancel.style.display = editing ? 'inline-block' : 'none';
  if (!editing) {
    if (keyIdInput) keyIdInput.value = '';
    if (keyInput) keyInput.value = '';
    if (keyTopic) keyTopic.value = '';
    if (keyLabel) keyLabel.value = '';
    if (keyUnit) keyUnit.value = '';
    return;
  }
  if (keyObj) {
    if (keyIdInput) keyIdInput.value = String(keyObj.id);
    if (keyInput) keyInput.value = keyObj.value_key || '';
    if (keyTopic) keyTopic.value = keyObj.topic || '';
    if (keyLabel) keyLabel.value = keyObj.label || '';
    if (keyUnit) keyUnit.value = keyObj.unit || '';
  }
}

async function fetchKeys(objectId) {
  const res = await fetch(`/api/objects/${objectId}/keys`);
  if (!res.ok) throw new Error('Fehler beim Laden der Keys');
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

async function loadKeys(preserveSelection = true) {
  const obj = getSelectedObject();
  if (!obj) {
    keysCache = [];
    renderKeyList([]);
    renderKeySelect([], '');
    renderAutomationKeyOptions('');
    drawChart([]);
    setKeyFormMode(false);
    return;
  }

  try {
    const list = await fetchKeys(obj.id);
    keysCache = list;
    renderKeyList(list);

    const selected = preserveSelection ? getSelectedKey() : '';
    const nextKey = selected && list.some((k) => k.value_key === selected)
      ? selected
      : (list[0]?.value_key || '');

    renderKeySelect(list, nextKey);
    if (keySelect && nextKey) keySelect.value = nextKey;

    setKeyFormMode(false);
    renderAutomationKeyOptions();
    await loadReadings();
  } catch (err) {
    if (keyList) keyList.innerHTML = `<li>Fehler: ${err.message || err}</li>`;
  }
}

async function fetchObjects() {
  const res = await fetch('/api/objects');
  if (!res.ok) throw new Error('Fehler beim Laden');
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

function renderObjectList(list) {
  if (!objectList) return;

  if (!list.length) {
    objectList.innerHTML = '<li>Keine Objekte vorhanden</li>';
    return;
  }

 

  objectList.innerHTML = list.map((o) => {
    const created = o.created_at ? new Date(o.created_at).toLocaleString() : '-';
    const topic = o.mqtt_topic ? `Topic: ${escapeHtml(o.mqtt_topic)}` : 'Kein Topic';
    return `
      <li data-id="${o.id}">
        <span class="obj-name">${escapeHtml(o.name)}</span>
        <span class="obj-date">${created}</span>
        <span class="obj-topic">${topic}</span>
        <button class="obj-delete" type="button">Loeschen</button>
      </li>
    `;
  }).join('');
}





function renderObjectSelect(list, selectedId) {
  if (!objectSelect) return;

  if (!list.length) {
    objectSelect.innerHTML = '';
    return;
  }

  objectSelect.innerHTML = list.map((o) => {
    const sel = Number(o.id) === Number(selectedId) ? 'selected' : '';
    return `<option value="${o.id}" ${sel}>${escapeHtml(o.name)}</option>`;
  }).join('');
}

function getSelectedObject() {
  const id = Number(objectSelect?.value);
  if (!Number.isFinite(id)) return null;
  return objectsCache.find((o) => Number(o.id) === id) || null;
}

function renderCommands(commands) {
  if (!commandList) return;

  if (!Array.isArray(commands) || commands.length === 0) {
    commandList.innerHTML = '<li>Keine Befehle definiert</li>';
    return;
  }

  commandList.innerHTML = commands.map((c, idx) => {
    const topic = c.topic ? ` [${escapeHtml(c.topic)}]` : '';
    return `
      <li data-index="${idx}">
        <div class="cmd-meta" style="display: grid; gap: 0.5rem; min-width: 0;">
          <span class="cmd-label">${escapeHtml(c.label)}${topic}</span>
          <span class="cmd-payload">${escapeHtml(c.payload)}</span>
        </div>
        <button class="cmd-send" type="button">Senden</button>
        <div class="cmd-action-group" style="display: flex; gap: 0.5rem; min-width: 0; justify-content: flex-end;">
          <button class="cmd-edit" type="button">Bearbeiten</button>
          <button class="cmd-delete" type="button">Loeschen</button>
        </div>
      </li>
    `;
  }).join('');
}
