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
    const listLimit = getLimit();
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

    const listView = list.slice(0, listLimit);
    readingsList.innerHTML = listView.map((r) => {
      const ts = r.created_at ? new Date(r.created_at).toLocaleString() : '-';
      const key = r.value_key ? `${escapeHtml(r.value_key)} = ` : '';
      const unit = r.value_key ? getUnitForKey(r.value_key) : '';
      const val = escapeHtml(r.value_text ?? '');
      const valWithUnit = unit ? `${val} ${escapeHtml(unit)}` : val;
      return `<li>${ts} - ${key}${valWithUnit}</li>`;
    }).join('');

    const ordered = list.slice().reverse();
    chartDataCache = ordered;
    chartHoverIndex = null;
    drawChart(ordered);
    lastReadingsCache = list;
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

// Object config
const objectSelect = document.getElementById('object-select');
const deviceTopic = document.getElementById('device-topic');
const topicSelect = document.getElementById('topic-select');
const deviceSave = document.getElementById('device-save');
const commandForm = document.getElementById('command-form');
const commandLabel = document.getElementById('command-label');
const commandPayload = document.getElementById('command-payload');
const commandList = document.getElementById('command-list');
const configStatus = document.getElementById('object-config-status');
const keyForm = document.getElementById('key-form');
const keyIdInput = document.getElementById('key-id');
const keyInput = document.getElementById('key-input');
const keyLabel = document.getElementById('key-label');
const keyUnit = document.getElementById('key-unit');
const keySave = document.getElementById('key-save');
const keyCancel = document.getElementById('key-cancel');
const keyList = document.getElementById('key-list');
const keySelect = document.getElementById('key-select');
const graphRefresh = document.getElementById('graph-refresh');
const readingsLimit = document.getElementById('readings-limit');
const exportCsvBtn = document.getElementById('export-csv');
const chartCanvas = document.getElementById('readings-chart');
const dateFrom = document.getElementById('date-from');
const dateTo = document.getElementById('date-to');
const autoRefreshToggle = document.getElementById('auto-refresh');
const autoRefreshSec = document.getElementById('auto-refresh-sec');
const readingsRefresh = document.getElementById('readings-refresh');
const readingsStatus = document.getElementById('readings-status');
const readingsList = document.getElementById('readings-list');

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getLimit() {
  const n = Number(readingsLimit?.value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 1), 1000);
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

  // X labels (first/middle/last)
  const len = readings.length;
  const idxs = [0, Math.floor(len / 2), len - 1].filter((v, i, a) => a.indexOf(v) === i);
  ctx.fillStyle = '#94a3b8';
  idxs.forEach((i) => {
    const x = pad + (i / xSpan) * (w - pad * 2);
    const ts = readings[i]?.created_at ? new Date(readings[i].created_at) : null;
    const label = ts ? ts.toLocaleTimeString() : String(i);
    ctx.fillText(label, x - 20, h - 10);
  });

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
    const label = k.label ? ` (${escapeHtml(k.label)})` : '';
    const unit = k.unit ? ` [${escapeHtml(k.unit)}]` : '';
    return `
      <li data-id="${k.id}">
        <span class="key-name">${escapeHtml(k.value_key)}${label}${unit}</span>
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
    const label = k.label ? ` (${k.label})` : '';
    const unit = k.unit ? ` [${k.unit}]` : '';
    return `<option value="${escapeHtml(k.value_key)}" ${sel}>${escapeHtml(k.value_key + label + unit)}</option>`;
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
    if (keyLabel) keyLabel.value = '';
    if (keyUnit) keyUnit.value = '';
    return;
  }
  if (keyObj) {
    if (keyIdInput) keyIdInput.value = String(keyObj.id);
    if (keyInput) keyInput.value = keyObj.value_key || '';
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
    return `
      <li data-index="${idx}">
        <span class="cmd-label">${escapeHtml(c.label)}</span>
        <span class="cmd-payload">${escapeHtml(c.payload)}</span>
        <button class="cmd-send" type="button">Senden</button>
        <button class="cmd-delete" type="button">Loeschen</button>
      </li>
    `;
  }).join('');
}

function renderSelectedObject() {
  const obj = getSelectedObject();
  if (!obj) {
    if (deviceTopic) deviceTopic.value = '';
    currentCommands = [];
    renderCommands([]);
    return;
  }

  if (deviceTopic) deviceTopic.value = obj.mqtt_topic || '';
  loadTopics(deviceTopic?.value?.trim() || '');
  loadTopicCommands(deviceTopic?.value?.trim() || '');
}

async function loadObjects(preserveSelection = true) {
  const selectedId = preserveSelection ? Number(objectSelect?.value) : null;

  if (objectList) objectList.innerHTML = '<li>Lade ...</li>';
  try {
    const list = await fetchObjects();
    objectsCache = list;

    renderObjectList(list);

    const fallbackId = list[0]?.id ?? null;
    const nextId = selectedId || fallbackId;
    renderObjectSelect(list, nextId);

    if (nextId && objectSelect) {
      objectSelect.value = String(nextId);
    }

    renderSelectedObject();
    await loadKeys();
  } catch (err) {
    if (objectList) objectList.innerHTML = `<li>Fehler: ${err.message || err}</li>`;
  }
}

async function createObject(name) {
  const res = await fetch('/api/objects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Anlegen fehlgeschlagen');
  return data;
}

async function updateObject(id, patch) {
  const res = await fetch(`/api/objects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Update fehlgeschlagen');
  return data;
}

async function createValueKeyForObject(objectId, valueKey, label, unit) {
  const res = await fetch(`/api/objects/${objectId}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueKey, label, unit })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Key anlegen fehlgeschlagen');
  return data;
}

async function deleteValueKeyForObject(objectId, keyId) {
  const res = await fetch(`/api/objects/${objectId}/keys/${keyId}`, {
    method: 'DELETE'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Key löschen fehlgeschlagen');
  return data;
}

async function updateValueKeyForObject(objectId, keyId, valueKey, label, unit) {
  const res = await fetch(`/api/objects/${objectId}/keys/${keyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueKey, label, unit })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Key speichern fehlgeschlagen');
  return data;
}

async function fetchTopicCommands(objectId, topic) {
  const url = topic
    ? `/api/objects/${objectId}/commands?topic=${encodeURIComponent(topic)}`
    : `/api/objects/${objectId}/commands`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Befehle laden fehlgeschlagen');
  return data;
}

async function saveTopicCommands(objectId, topic, commands) {
  const res = await fetch(`/api/objects/${objectId}/commands`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, commands })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Befehle speichern fehlgeschlagen');
  return data;
}

async function fetchTopics(objectId) {
  const res = await fetch(`/api/objects/${objectId}/topics`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Topics laden fehlgeschlagen');
  return Array.isArray(data.topics) ? data.topics : [];
}

function renderTopicSelect(list, selected) {
  if (!topicSelect) return;
  const options = ['(manuell)', ...list];
  topicSelect.innerHTML = options.map((t) => {
    const sel = t === selected ? 'selected' : '';
    return `<option value="${escapeHtml(t)}" ${sel}>${escapeHtml(t)}</option>`;
  }).join('');
}

async function loadTopics(preferTopic) {
  const obj = getSelectedObject();
  if (!obj) {
    topicsCache = [];
    if (topicSelect) topicSelect.innerHTML = '';
    return;
  }

  try {
    const list = await fetchTopics(obj.id);
    topicsCache = list;
    const current = preferTopic || deviceTopic?.value?.trim() || obj.mqtt_topic || '';
    const selected = list.includes(current) ? current : '(manuell)';
    renderTopicSelect(list, selected);
    if (selected !== '(manuell)' && deviceTopic) deviceTopic.value = selected;
  } catch {
    topicsCache = [];
    if (topicSelect) topicSelect.innerHTML = '';
  }
}

async function loadTopicCommands(topic) {
  const obj = getSelectedObject();
  if (!obj) return;

  try {
    const data = await fetchTopicCommands(obj.id, topic);
    currentCommands = Array.isArray(data.commands) ? data.commands : [];
    renderCommands(currentCommands);
  } catch (err) {
    currentCommands = [];
    renderCommands([]);
  }
}

async function deleteObject(id) {
  const res = await fetch(`/api/objects/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'LÃ¶schen fehlgeschlagen');
  return data;
}

objectForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = (objectName?.value || '').trim();
  if (!name) {
    setObjectStatus('Name fehlt.', true);
    return;
  }
  setObjectStatus('Erstelle ...');
  if (objectCreate) objectCreate.disabled = true;

  try {
    await createObject(name);
    if (objectName) objectName.value = '';
    setObjectStatus('Erstellt.');
    await loadObjects(false);
  } catch (err) {
    setObjectStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    if (objectCreate) objectCreate.disabled = false;
  }
});

objectRefresh?.addEventListener('click', () => {
  setObjectStatus('');
  loadObjects();
});

objectList?.addEventListener('click', async (e) => {
  const btn = e.target?.closest('.obj-delete');
  if (!btn) return;

  const li = btn.closest('li');
  const id = li?.getAttribute('data-id');
  if (!id) return;

  btn.disabled = true;
  setObjectStatus('LÃ¶sche ...');

  try {
    await deleteObject(id);
    setObjectStatus('GelÃ¶scht.');
    await loadObjects();
  } catch (err) {
    setObjectStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    btn.disabled = false;
  }
});

// Objekt-Auswahl
objectSelect?.addEventListener('change', () => {
  setConfigStatus('');
  renderSelectedObject();
  loadKeys(false);
});

// Topic speichern
deviceSave?.addEventListener('click', async () => {
  const obj = getSelectedObject();
  if (!obj) return;

  const topic = (deviceTopic?.value || '').trim();
  setConfigStatus('Speichere ...');

  deviceSave.disabled = true;
  try {
    await updateObject(obj.id, { mqttTopic: topic });
    setConfigStatus('Gespeichert.');
    await loadObjects();
    await loadTopics(topic);
    await loadTopicCommands(topic);
  } catch (err) {
    setConfigStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    deviceSave.disabled = false;
  }
});

deviceTopic?.addEventListener('change', () => {
  const topic = (deviceTopic?.value || '').trim();
  loadTopicCommands(topic);
  loadTopics(topic);
});

readingsRefresh?.addEventListener('click', () => {
  setReadingsStatus('');
  loadReadings();
});

graphRefresh?.addEventListener('click', () => {
  setReadingsStatus('');
  loadReadings();
});

chartCanvas?.addEventListener('mousemove', (e) => {
  if (!chartMeta) return;
  const rect = chartCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = (x - chartMeta.pad) / (chartMeta.w - chartMeta.pad * 2);
  if (t < 0 || t > 1) {
    hideChartTooltip();
    return;
  }
  const idx = Math.round(t * (chartMeta.readings.length - 1));
  const nearest = findNearestIndex(idx, chartMeta.valuesByIndex);
  if (nearest < 0) {
    hideChartTooltip();
    return;
  }

  const value = chartMeta.valuesByIndex[nearest];
  const y = chartMeta.h - chartMeta.pad - ((value - chartMeta.min) / chartMeta.span) * (chartMeta.h - chartMeta.pad * 2);
  const time = chartMeta.readings[nearest]?.created_at
    ? new Date(chartMeta.readings[nearest].created_at).toLocaleString()
    : '';
  const unit = chartMeta.unit ? ` ${chartMeta.unit}` : '';
  const meta = getSelectedKeyMeta();
  const name = meta?.label ? `${meta.label} (${meta.value_key})` : (meta?.value_key || '');
  const prefix = name ? `${name}: ` : '';

  const tooltip = getChartTooltip();
  tooltip.textContent = `${time} | ${prefix}${value.toFixed(2)}${unit}`;
  tooltip.style.left = `${e.clientX + 12}px`;
  tooltip.style.top = `${e.clientY + 12}px`;
  tooltip.style.display = 'block';

  chartHoverIndex = nearest;
  if (chartDataCache.length) drawChart(chartDataCache);
});

chartCanvas?.addEventListener('mouseleave', () => {
  hideChartTooltip();
  chartHoverIndex = null;
  if (chartDataCache.length) drawChart(chartDataCache);
});

keySelect?.addEventListener('change', () => {
  loadReadings();
});

topicSelect?.addEventListener('change', () => {
  const selected = topicSelect?.value || '(manuell)';
  if (selected !== '(manuell)' && deviceTopic) {
    deviceTopic.value = selected;
  }
  const topic = (deviceTopic?.value || '').trim();
  loadTopicCommands(topic);
});

readingsLimit?.addEventListener('change', () => {
  loadReadings();
});

exportCsvBtn?.addEventListener('click', () => {
  if (!lastReadingsCache.length) {
    setReadingsStatus('Keine Daten zum Export.', true);
    return;
  }
  downloadCsv(lastReadingsCache);
});

dateFrom?.addEventListener('change', () => {
  loadReadings();
});

dateTo?.addEventListener('change', () => {
  loadReadings();
});

autoRefreshToggle?.addEventListener('change', () => {
  setupAutoRefresh();
  if (autoRefreshToggle.checked) loadReadings();
});

autoRefreshSec?.addEventListener('change', () => {
  setupAutoRefresh();
});

keyForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const obj = getSelectedObject();
  if (!obj) return;

  const valueKey = (keyInput?.value || '').trim();
  const label = (keyLabel?.value || '').trim();
  const unit = (keyUnit?.value || '').trim();
  const keyId = Number(keyIdInput?.value);
  const isEdit = Number.isFinite(keyId) && keyId > 0;
  if (!valueKey) {
    setConfigStatus('Key fehlt.', true);
    return;
  }

  if (keySave) keySave.disabled = true;
  setConfigStatus(isEdit ? 'Key speichern ...' : 'Key hinzufügen ...');

  try {
    if (isEdit) {
      await updateValueKeyForObject(obj.id, keyId, valueKey, label, unit);
      setConfigStatus('Key gespeichert.');
    } else {
      await createValueKeyForObject(obj.id, valueKey, label, unit);
      setConfigStatus('Key hinzugefügt.');
    }
    setKeyFormMode(false);
    await loadKeys(false);
  } catch (err) {
    setConfigStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    if (keySave) keySave.disabled = false;
  }
});

keyCancel?.addEventListener('click', () => {
  setKeyFormMode(false);
});

keyList?.addEventListener('click', async (e) => {
  const editBtn = e.target?.closest('.key-edit');
  const delBtn = e.target?.closest('.key-delete');
  if (!editBtn && !delBtn) return;

  const obj = getSelectedObject();
  if (!obj) return;

  const li = (editBtn || delBtn).closest('li');
  const keyId = Number(li?.getAttribute('data-id'));
  if (!Number.isFinite(keyId)) return;

  if (editBtn) {
    const keyObj = keysCache.find((k) => k.id === keyId);
    if (keyObj) setKeyFormMode(true, keyObj);
    return;
  }

  if (delBtn) {
    delBtn.disabled = true;
    setConfigStatus('Key löschen ...');

    try {
      await deleteValueKeyForObject(obj.id, keyId);
      setConfigStatus('Key gelöscht.');
      await loadKeys();
    } catch (err) {
      setConfigStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      delBtn.disabled = false;
    }
  }
});

// Command hinzufÃ¼gen
commandForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const obj = getSelectedObject();
  if (!obj) return;

  const label = (commandLabel?.value || '').trim();
  const payload = (commandPayload?.value || '');
  const topic = (deviceTopic?.value || '').trim();

  if (!label) {
    setConfigStatus('Button-Name fehlt.', true);
    return;
  }
  if (!topic) {
    setConfigStatus('Bitte MQTT Topic speichern.', true);
    return;
  }

  const nextCommands = [...currentCommands, { label, payload }];
  setConfigStatus('Speichere Befehle ...');

  const addBtn = document.getElementById('command-add');
  if (addBtn) addBtn.disabled = true;

  try {
    await saveTopicCommands(obj.id, topic, nextCommands);
    if (commandLabel) commandLabel.value = '';
    if (commandPayload) commandPayload.value = '';
    setConfigStatus('Befehl hinzugefügt.');
    currentCommands = nextCommands;
    renderCommands(currentCommands);
    await loadTopics(topic);
  } catch (err) {
    setConfigStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    if (addBtn) addBtn.disabled = false;
  }
});

// Command senden / lÃ¶schen
commandList?.addEventListener('click', async (e) => {
  const obj = getSelectedObject();
  if (!obj) return;

  const sendBtn = e.target?.closest('.cmd-send');
  const delBtn = e.target?.closest('.cmd-delete');
  if (!sendBtn && !delBtn) return;

  const li = e.target.closest('li');
  const idx = Number(li?.getAttribute('data-index'));
  if (!Number.isFinite(idx)) return;

  if (sendBtn) {
    const topic = (deviceTopic?.value || '').trim();
    if (!topic) {
      setConfigStatus('Bitte MQTT Topic speichern.', true);
      return;
    }
    sendBtn.disabled = true;
    setConfigStatus('Sende ...');
    try {
      const cmd = currentCommands?.[idx];
      await publishMqtt(topic, cmd?.payload ?? '');
      setConfigStatus('Gesendet.');
    } catch (err) {
      setConfigStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      sendBtn.disabled = false;
    }
  }

  if (delBtn) {
    const topic = (deviceTopic?.value || '').trim();
    delBtn.disabled = true;
    setConfigStatus('LÃ¶sche ...');
    try {
      const nextCommands = (currentCommands || []).filter((_, i) => i !== idx);
      await saveTopicCommands(obj.id, topic, nextCommands);
      setConfigStatus('GelÃ¶scht.');
      currentCommands = nextCommands;
      renderCommands(currentCommands);
      await loadTopics(topic);
    } catch (err) {
      setConfigStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      delBtn.disabled = false;
    }
  }
});

loadObjects();
setupAutoRefresh();

