// MQTT (manuell)
const form = document.getElementById('mqtt-form');
const topicInput = document.getElementById('mqtt-topic');
const payloadInput = document.getElementById('mqtt-payload');
const statusEl = document.getElementById('mqtt-status');
const sendBtn = document.getElementById('mqtt-send');

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--success)';
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


async function fetchReadings(limit, includeFilters = true, chart = false, signal) {
  const obj = getSelectedObject();
  if (!obj) return [];

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (chart) params.set('view', 'chart');
  if (includeFilters) {
    const key = getSelectedKey();
    const range = getDateRange();
    if (range.from && range.to && range.from > range.to) throw new Error('„Von“ muss vor „Bis“ liegen.');
    if (key) params.set('key', key);
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
  }

  // Bound the complete response, including JSON reads. Keep selection changes
  // able to cancel the request without leaving automatic refresh waiting.
  const timeout = AbortSignal.timeout(12000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`/api/objects/${obj.id}/readings?${params.toString()}`, { signal: requestSignal });
  if (res.status === 401 || res.status === 403) throw new Error('Bitte erneut anmelden. Deine Sitzung ist abgelaufen.');
  if (!res.ok) throw new Error(`Messwerte konnten nicht geladen werden (HTTP ${res.status}). Bitte erneut versuchen.`);
  const list = await res.json().catch((error) => {
    if (requestSignal.aborted) throw requestSignal.reason;
    throw new Error('Der Server hat keine lesbaren Messwerte geliefert. Bitte erneut versuchen.');
  });
  if (chart) {
    return HydroChart.normalizeChartResponse(list, limit);
  }
  return Array.isArray(list) ? list : [];
}

async function fetchReadingsForKey(key, limit, signal, objectId = null) {
  const targetObjId = objectId || getSelectedObject()?.id;
  if (!targetObjId || !key) return { readings: [] };
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('view', 'chart');
  params.set('key', key);
  const range = getDateRange();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);

  const timeout = AbortSignal.timeout(12000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`/api/objects/${targetObjId}/readings?${params.toString()}`, { signal: requestSignal });
  if (!res.ok) return { readings: [] };
  const list = await res.json().catch(() => []);
  return HydroChart.normalizeChartResponse(list, limit);
}

let chartRequestController = null;
async function loadReadings() {
  chartRequestController?.abort();
  const controller = new AbortController();
  chartRequestController = controller;
  const graphStatus = document.getElementById('graph-status');
  const retry = document.getElementById('graph-retry');
  retry.hidden = true;
  graphStatus.classList.remove('refresh-error');
  chartCanvas?.setAttribute('aria-busy', 'true');
  lastReadingsCache = [];
  if (exportCsvBtn) exportCsvBtn.disabled = true;
  const obj = getSelectedObject();
  if (!obj) {
    chartCanvas?.setAttribute('aria-busy', 'false');
    graphStatus.textContent = 'Bitte zuerst ein Objekt auswählen.';
    drawChart([]);
    lastReadingsCache = [];
    chartDataCache = [];
    chartHoverIndex = null;
    return;
  }

  try {
    graphStatus.textContent = 'Zeitraum wird geladen …';
    const result = await fetchReadings(2000, true, true, controller.signal);
    if (controller !== chartRequestController) return;
    const list = result.readings;
    const coverage = result.from && result.to
      ? `${new Date(result.from).toLocaleString()} – ${new Date(result.to).toLocaleString()}` : '';
    graphStatus.textContent = result.legacy
      ? `${list.length} Messwerte im bisherigen Serverformat${coverage ? ` · ${coverage}` : ''}. ${result.possiblyTruncated ? 'Die Liste ist möglicherweise auf die neuesten Werte gekürzt. ' : ''}Für die vollständige Zeitraum-Ansicht den Server aktualisieren und neu starten.`
      : result.sampled
      ? `${list.length} von ${result.total} Messwerten als Stichprobe über den gesamten Zeitraum (${coverage}). Kurze Spitzen können fehlen; für Details Zeitraum eingrenzen. CSV enthält die angezeigte Stichprobe.`
      : list.length ? `${list.length} Messwerte · ${coverage}` : 'Keine Messwerte im gewählten Zeitraum.';
    if (result.omittedTextValues) {
      graphStatus.textContent += ` ${result.omittedTextValues} überlange Textwerte sind im Graphen und CSV ausgelassen (Spalte text_omitted).`;
    }

    if (list.length === 0) {
      drawChart([]);
      lastReadingsCache = [];
      chartDataCache = [];
      chartHoverIndex = null;
      return;
    }

    const ordered = list.slice().reverse();
    chartDataCache = ordered;
    chartHoverIndex = null;

    let secondaryOrdered = null;
    const secSel = getSecondarySelection();
    const isSameAsPrimary = secSel && Number(secSel.objectId) === Number(obj.id) && secSel.key === getSelectedKey();
    if (secSel && !isSameAsPrimary) {
      try {
        const secRes = await fetchReadingsForKey(secSel.key, 2000, controller.signal, secSel.objectId);
        if (secRes?.readings?.length) {
          secondaryOrdered = secRes.readings.slice().reverse();
        }
      } catch (err) {
        console.warn('Fehler beim Abruf des Vergleichswerts:', err);
      }
    }
    secondaryChartDataCache = secondaryOrdered;

    drawChart(ordered, secondaryChartDataCache);
    lastReadingsCache = list;
    if (exportCsvBtn) exportCsvBtn.disabled = false;
    checkThresholds(list);
    updateSensorDeckForCurrentKey(list);
  } catch (err) {
    if (controller !== chartRequestController || err.name === 'AbortError') return;
    graphStatus.textContent = err.message || 'Messwerte konnten nicht geladen werden.';
    graphStatus.classList.add('refresh-error');
    retry.hidden = false;
    drawChart([]);
    lastReadingsCache = [];
    chartDataCache = [];
    chartHoverIndex = null;
  } finally {
    if (controller === chartRequestController) chartCanvas?.setAttribute('aria-busy', 'false');
  }
}

async function loadRealtimeReadings() {
  if (!readingsList || !isReadingsLogOpen()) return;

  const obj = getSelectedObject();
  if (!obj) {
    readingsList.innerHTML = '<li>Kein Objekt ausgewählt</li>';
    return;
  }

  readingsList.innerHTML = '<li>Lade die letzten 20 Messwerte ...</li>';
  try {
    const list = await fetchReadings(20, false);
    if (list.length === 0) {
      readingsList.innerHTML = '<li>Keine Messwerte vorhanden</li>';
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
  } catch (err) {
    readingsList.innerHTML = `<li>Fehler: ${escapeHtml(err.message || err)}</li>`;
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
const secondaryKeySelect = document.getElementById('secondary-key-select');
const sensorDeckEl = document.getElementById('hydro-sensor-deck');
const latestKeyReadingsCache = new Map();
const graphRefresh = document.getElementById('graph-refresh');
const exportCsvBtn = document.getElementById('export-csv');
const chartCanvas = document.getElementById('readings-chart');
const dateFrom = document.getElementById('date-from');
const dateTo = document.getElementById('date-to');
const autoRefreshToggle = document.getElementById('auto-refresh');
const autoRefreshSec = document.getElementById('auto-refresh-sec');
const readingsLogSection = document.getElementById('log-section');
const readingsLogToggle = document.getElementById('readings-log-toggle');
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
let allObjectsKeysCache = [];
let lastReadingsCache = [];
let chartMeta = null;
let chartTooltip = null;
let chartHoverIndex = null;
let chartDataCache = [];
let secondaryChartDataCache = null;
let autoRefreshTimer = null;
const GRAPH_LIMIT = 1000;

function isReadingsLogOpen() {
  return Boolean(readingsLogSection && !readingsLogSection.classList.contains('collapsed'));
}
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
  objectStatus.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function setConfigStatus(text, isError = false) {
  if (!configStatus) return;
  configStatus.textContent = text;
  configStatus.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function setKeyStatus(text, isError = false) {
  const status = document.getElementById('key-config-status');
  status.textContent = text;
  status.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function setReadingsStatus(text, isError = false) {
  if (!readingsStatus) return;
  readingsStatus.textContent = text;
  readingsStatus.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function setAutomationStatus(text, isError = false) {
  if (!automationStatus) return;
  automationStatus.textContent = text;
  automationStatus.style.color = isError ? 'var(--danger)' : 'var(--success)';
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

function updateSensorDeckForCurrentKey(readings) {
  const currentObj = getSelectedObject();
  const currentKey = getSelectedKey();
  if (!currentKey) return;
  const list = Array.isArray(readings) ? readings : [];
  if (!list.length) {
    renderSensorDeck();
    return;
  }

  const latest = list[0];
  const previous = list[1] || null;
  const val = parseNumber(latest.value_text);
  const prevVal = previous ? parseNumber(previous.value_text) : null;

  let trend = 'stable';
  if (Number.isFinite(val) && Number.isFinite(prevVal)) {
    const diff = val - prevVal;
    if (diff > 0.05) trend = 'up';
    else if (diff < -0.05) trend = 'down';
  }

  const { min, max } = loadThresholdSettings();
  let status = 'optimal';
  if (Number.isFinite(val)) {
    if ((Number.isFinite(min) && val < min) || (Number.isFinite(max) && val > max)) {
      status = 'warning';
    }
  }

  const entryMeta = {
    valText: latest.value_text,
    valNum: val,
    trend,
    status,
    ts: latest.created_at
  };
  latestKeyReadingsCache.set(currentKey, entryMeta);
  if (currentObj?.id != null) {
    latestKeyReadingsCache.set(`${currentObj.id}:${currentKey}`, entryMeta);
  }

  renderSensorDeck();
}

function renderSensorDeck() {
  if (!sensorDeckEl) return;
  const currentObj = getSelectedObject();
  const currentObjId = Number(currentObj?.id);
  const currentKey = getSelectedKey();
  const secSel = getSecondarySelection();

  const deckItems = allObjectsKeysCache.length
    ? allObjectsKeysCache
    : (keysCache || []).map((k) => ({
        ...k,
        objectId: currentObjId,
        objectName: currentObj?.name || ''
      }));

  if (!deckItems.length) {
    sensorDeckEl.innerHTML = '';
    return;
  }

  const multiObject = objectsCache.length > 1;

  sensorDeckEl.innerHTML = deckItems.map((k) => {
    const objId = Number(k.objectId || currentObjId);
    const objName = k.objectName || currentObj?.name || '';
    const compositeKey = `${objId}:${k.value_key}`;
    const meta = latestKeyReadingsCache.get(compositeKey) || (objId === currentObjId ? latestKeyReadingsCache.get(k.value_key) : null);
    const isSelected = objId === currentObjId && k.value_key === currentKey;
    const isSecSelected = Boolean(secSel && Number(secSel.objectId) === objId && secSel.key === k.value_key);
    const unit = k.unit ? ` ${escapeHtml(k.unit)}` : '';
    const valText = meta ? `${escapeHtml(meta.valText)}${unit}` : '--';
    const trendIcon = meta?.trend === 'up' ? '↗' : meta?.trend === 'down' ? '↘' : meta?.trend === 'stable' ? '→' : '';
    const statusClass = meta?.status === 'warning' ? 'status-danger' : meta ? 'status-online' : 'status-waiting';
    const statusLabel = meta?.status === 'warning' ? 'Außerhalb Schwellenwert' : meta ? 'Normal / Optimal' : 'Wartet auf Messung';

    const nameLow = (k.label || k.value_key || '').toLowerCase();
    const icon = nameLow.includes('temp') ? '🌡️' : nameLow.includes('ph') ? '🧪' : (nameLow.includes('ec') || nameLow.includes('leit')) ? '⚡' : (nameLow.includes('feucht') || nameLow.includes('wasser') || nameLow.includes('hum')) ? '💧' : '🌱';

    return `
      <div class="hydro-sensor-card ${isSelected ? 'is-selected' : ''} ${isSecSelected ? 'is-secondary-selected' : ''}" data-sensor-obj="${objId}" data-sensor-key="${escapeHtml(k.value_key)}" role="button" tabindex="0" title="Primärverlauf für ${escapeHtml((objName ? objName + ' · ' : '') + (k.label || k.value_key))} anzeigen">
        <div class="hydro-sensor-top">
          <span class="hydro-sensor-icon">${icon}</span>
          <span class="hydro-sensor-label">
            ${multiObject && objName ? `<small class="hydro-sensor-obj-badge">${escapeHtml(objName)}</small> ` : ''}${escapeHtml(k.label || k.value_key)}
          </span>
          ${!isSelected ? `<button type="button" class="hydro-sensor-compare-btn ${isSecSelected ? 'is-active' : ''}" data-compare-spec="${escapeHtml(compositeKey)}" title="${isSecSelected ? 'Vergleichskurve ausblenden' : 'Als 2. Kurve (Rechte Achse) zusammenlegen'}">⇄</button>` : ''}
          <span class="hydro-ampel-dot ${statusClass}" title="${statusLabel}"></span>
        </div>
        <div class="hydro-sensor-body">
          <strong class="hydro-sensor-value">${valText}</strong>
          ${trendIcon ? `<span class="hydro-trend-badge trend-${meta.trend}" title="Trend: ${meta.trend === 'up' ? 'steigend' : meta.trend === 'down' ? 'fallend' : 'stabil'}">${trendIcon}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  sensorDeckEl.querySelectorAll('.hydro-sensor-compare-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const spec = btn.dataset.compareSpec || '';
      if (!secondaryKeySelect) return;
      const curSec = getSecondarySelection();
      if (curSec && curSec.raw === spec) {
        secondaryKeySelect.value = '';
      } else {
        secondaryKeySelect.value = spec;
      }
      renderSensorDeck();
      loadReadings();
    });
  });

  sensorDeckEl.querySelectorAll('.hydro-sensor-card').forEach((card) => {
    const handleSelect = async () => {
      const targetObjId = Number(card.dataset.sensorObj);
      const key = card.dataset.sensorKey;
      if (!key) return;
      const activeObj = getSelectedObject();
      if (Number.isFinite(targetObjId) && Number(activeObj?.id) !== targetObjId && objectSelect) {
        objectSelect.value = String(targetObjId);
        renderSelectedObject();
        await loadKeys(false, key);
        loadAutomations();
        populateThresholdInputs();
        loadHydroponicBrokerSummary();
        if (isReadingsLogOpen()) loadRealtimeReadings();
        return;
      }
      if (keySelect && keySelect.value !== key) {
        keySelect.value = key;
        keySelect.dispatchEvent(new Event('change'));
      }
    };
    card.addEventListener('click', handleSelect);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect();
      }
    });
  });
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
  const header = ['created_at', 'topic', 'value_key', 'value_text'];
  if (readings.some((row) => Object.hasOwn(row, 'raw_payload'))) header.push('raw_payload');
  if (readings.some((row) => row.text_omitted)) header.push('text_omitted');
  const lines = [header.join(',')];
  for (const r of readings) {
    const row = header.map((column) => r[column]).map((v) => {
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
  let refreshInFlight = false;
  autoRefreshTimer = setInterval(async () => {
    if (document.hidden || refreshInFlight) return;
    refreshInFlight = true;
    try {
      await loadReadings();
      if (isReadingsLogOpen()) await loadRealtimeReadings();
    } finally {
      refreshInFlight = false;
    }
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

function drawChart(readings = chartDataCache, secondaryReadings = undefined) {
  if (secondaryReadings === undefined) {
    secondaryReadings = secondaryChartDataCache;
  }
  const canvas = prepareCanvas();
  if (!canvas) return;
  const { ctx, w, h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const unit = getSelectedKeyUnit();

  if (!Array.isArray(readings) || readings.length === 0) {
    document.getElementById('chart-point-detail').textContent = 'Keine Messwerte zum Ablesen vorhanden.';
    chartMeta = null;
    hideChartTooltip();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Keine Daten', 12, 20);
    return;
  }

  const valuesByIndex = readings.map((r) => parseNumber(r.value_text));
  const values = valuesByIndex.filter((v) => Number.isFinite(v));

  if (values.length === 0) {
    document.getElementById('chart-point-detail').textContent = 'Dieser Messwert enthält keine numerischen Daten.';
    chartMeta = null;
    hideChartTooltip();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Keine numerischen Werte', 12, 20);
    return;
  }

  if (chartHoverIndex === null) {
    document.getElementById('chart-point-detail').textContent = 'Tippe auf den Graphen oder fahre mit der Maus darüber, um Messwerte abzulesen.';
  }

  const hasSec = Array.isArray(secondaryReadings) && secondaryReadings.length > 0;
  let secValuesByIndex = [];
  let secMin = 0;
  let secMax = 1;
  let secSpan = 1;
  let secUnit = '';
  let secLabel = 'Vergleich';

  if (hasSec) {
    secValuesByIndex = secondaryReadings.map((r) => parseNumber(r.value_text));
    const secFiniteValues = secValuesByIndex.filter((v) => Number.isFinite(v));
    if (secFiniteValues.length > 0) {
      secMin = Math.min(...secFiniteValues);
      secMax = Math.max(...secFiniteValues);
      const secRange = secMax - secMin || 1;
      secMin -= secRange * 0.06;
      secMax += secRange * 0.06;
      secSpan = secMax - secMin || 1;
      const secSel = getSecondarySelection();
      secUnit = secSel?.unit || '';
      const isCrossObject = secSel && Number(secSel.objectId) !== Number(getSelectedObject()?.id);
      secLabel = secSel
        ? (isCrossObject && secSel.objectName ? `${secSel.objectName} · ${secSel.label}` : secSel.label)
        : 'Vergleich';
    }
  }

  let min = Math.min(...values);
  let max = Math.max(...values);
  const range = max - min || 1;
  min -= range * 0.06;
  max += range * 0.06;
  const span = max - min || 1;

  const isCompactCanvas = w < 520;
  const padLeft = isCompactCanvas ? 40 : 52;
  const padRight = hasSec ? (isCompactCanvas ? 44 : 64) : (isCompactCanvas ? 16 : 32);
  const padTop = isCompactCanvas && hasSec ? 40 : 34;
  const padBottom = isCompactCanvas ? 32 : 38;
  const plotX = padLeft;
  const plotY = padTop;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  const primTimes = readings.map((r) => r?.created_at ? new Date(r.created_at).getTime() : NaN).filter(Number.isFinite);
  const secTimes = hasSec ? secondaryReadings.map((r) => r?.created_at ? new Date(r.created_at).getTime() : NaN).filter(Number.isFinite) : [];
  const allTimes = [...primTimes, ...secTimes];
  const minTime = allTimes.length > 1 ? Math.min(...allTimes) : 0;
  const maxTime = allTimes.length > 1 ? Math.max(...allTimes) : 0;
  const timeSpan = maxTime - minTime;
  const timeBased = timeSpan > 1000 && allTimes.length > 1;

  const getPrimaryX = (idx) => {
    if (timeBased && readings[idx]?.created_at) {
      const t = new Date(readings[idx].created_at).getTime();
      if (Number.isFinite(t)) return plotX + ((t - minTime) / timeSpan) * plotW;
    }
    return plotX + (idx / (readings.length - 1 || 1)) * plotW;
  };

  const getSecondaryX = (idx) => {
    if (timeBased && secondaryReadings[idx]?.created_at) {
      const t = new Date(secondaryReadings[idx].created_at).getTime();
      if (Number.isFinite(t)) return plotX + ((t - minTime) / timeSpan) * plotW;
    }
    return plotX + (idx / (secondaryReadings.length - 1 || 1)) * plotW;
  };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = computeMedian(values);
  const headBudget = Math.max(200, Math.floor(w));
  const maxPoints = GRAPH_TAIL + headBudget;
  const draw = buildDrawIndicesWithTail(valuesByIndex, maxPoints, GRAPH_TAIL);

  chartMeta = {
    readings,
    secondaryReadings,
    valuesByIndex,
    secValuesByIndex,
    min,
    max,
    secMin,
    secMax,
    span,
    secSpan,
    padLeft,
    padRight,
    padTop,
    padBottom,
    plotX,
    plotY,
    plotW,
    plotH,
    w,
    h,
    unit,
    secUnit,
    hasSec,
    timeBased,
    minTime,
    maxTime,
    timeSpan,
    draw
  };

  ctx.font = '11px system-ui, sans-serif';
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    const v = max - t * span;
    const y = plotY + t * plotH;

    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    const label = unit ? `${v.toFixed(1)} ${unit}` : v.toFixed(1);
    ctx.fillText(label, plotX - 8, y + 4);
  }

  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.beginPath();
  ctx.moveTo(plotX, plotY);
  ctx.lineTo(plotX, plotY + plotH);
  ctx.lineTo(plotX + plotW, plotY + plotH);
  ctx.stroke();

  if (hasSec) {
    ctx.strokeStyle = 'rgba(245,158,11,0.45)';
    ctx.beginPath();
    ctx.moveTo(plotX + plotW, plotY);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    ctx.textAlign = 'left';
    for (let i = 0; i < ticks; i++) {
      const t = i / (ticks - 1);
      const v = secMax - t * secSpan;
      const y = plotY + t * plotH;
      const label = secUnit ? `${v.toFixed(1)} ${secUnit}` : v.toFixed(1);
      ctx.fillText(label, plotX + plotW + 8, y + 4);
    }
  }

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  const numLabels = Math.min(5, readings.length);
  for (let k = 0; k < numLabels; k++) {
    const fraction = numLabels <= 1 ? 0 : k / (numLabels - 1);
    const xPos = plotX + fraction * plotW;
    let timeLabel = '';
    let dateLabel = '';
    if (timeBased && timeSpan > 0) {
      const curT = new Date(minTime + fraction * timeSpan);
      timeLabel = curT.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      dateLabel = curT.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
    } else {
      const readingIdx = Math.floor(fraction * (readings.length - 1));
      const ts = readings[readingIdx]?.created_at ? new Date(readings[readingIdx].created_at) : null;
      if (ts) {
        timeLabel = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        dateLabel = ts.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
      } else {
        timeLabel = String(readingIdx);
      }
    }
    ctx.fillText(timeLabel, xPos, plotY + plotH + 16);
    if (k === 0 || k === numLabels - 1 || numLabels <= 3) {
      ctx.fillText(dateLabel, xPos, plotY + plotH + 30);
    }
  }
  ctx.textAlign = 'left';

  const drawPrimaryPath = (indices, color, lineWidth = 2) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let started = false;
    indices.forEach((idx) => {
      const v = valuesByIndex[idx];
      if (!Number.isFinite(v)) {
        started = false;
        return;
      }
      const x = getPrimaryX(idx);
      const y = plotY + plotH - ((v - min) / span) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };

  drawPrimaryPath(chartMeta.draw.head, '#3b82f6', 2);
  drawPrimaryPath(chartMeta.draw.tail, '#22d3ee', 2);

  if (!hasSec && Number.isFinite(mean)) {
    const y = plotY + plotH - ((mean - min) / span) * plotH;
    ctx.strokeStyle = 'rgba(34,197,94,0.7)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#22c55e';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`Mittel: ${mean.toFixed(1)} ${unit || ''}`, plotX + plotW - 120, y - 4);
  }

  if (hasSec && Array.isArray(secondaryReadings) && secondaryReadings.length > 0) {
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    secondaryReadings.forEach((r, idx) => {
      const v = parseNumber(r.value_text);
      if (!Number.isFinite(v)) {
        started = false;
        return;
      }
      const x = getSecondaryX(idx);
      const y = plotY + plotH - ((v - secMin) / secSpan) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  const primKeyObj = getSelectedKeyMeta();
  const basePrimLabel = primKeyObj?.label || getSelectedKey() || 'Primär';
  const secSelForLegend = hasSec ? getSecondarySelection() : null;
  const isCrossObjectLegend = secSelForLegend && Number(secSelForLegend.objectId) !== Number(getSelectedObject()?.id);
  const primLabel = isCrossObjectLegend && getSelectedObject()?.name
    ? `${getSelectedObject().name} · ${basePrimLabel}`
    : basePrimLabel;
  ctx.font = isCompactCanvas ? '11px system-ui, sans-serif' : '12px system-ui, sans-serif';

  const primText = `${primLabel} (${unit || '-'})`;
  const secText = hasSec ? `${secLabel} (${secUnit || '-'})` : '';
  const primWidth = ctx.measureText(primText).width;
  const secWidth = hasSec ? ctx.measureText(secText).width : 0;
  const stackLegend = Boolean(isCompactCanvas && hasSec && (plotX + 20 + primWidth + 20 + 20 + secWidth > w - 6));

  const primLegendY = stackLegend ? 13 : 18;
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(plotX, primLegendY - 6, 12, 4);
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(primText, plotX + 16, primLegendY);

  if (hasSec) {
    const secLegendX = stackLegend ? plotX : (plotX + 20 + primWidth + 24);
    const secLegendY = stackLegend ? 28 : 18;
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(secLegendX, secLegendY - 6, 12, 4);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(secText, secLegendX + 16, secLegendY);
  }

  if (chartHoverIndex !== null) {
    const idx = findNearestIndex(chartHoverIndex, valuesByIndex);
    if (idx >= 0 && Number.isFinite(valuesByIndex[idx])) {
      const cursorX = getPrimaryX(idx);
      const primY = plotY + plotH - ((valuesByIndex[idx] - min) / span) * plotH;

      ctx.strokeStyle = 'rgba(148,163,184,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cursorX, plotY);
      ctx.lineTo(cursorX, plotY + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(cursorX, primY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#083344';
      ctx.lineWidth = 2;
      ctx.stroke();

      if (hasSec && Array.isArray(secValuesByIndex) && secValuesByIndex.length > 0) {
        let secIdx = -1;
        if (timeBased && readings[idx]?.created_at) {
          const primTime = new Date(readings[idx].created_at).getTime();
          let minDiff = Infinity;
          secondaryReadings.forEach((sr, sI) => {
            const st = new Date(sr.created_at).getTime();
            if (Number.isFinite(st)) {
              const diff = Math.abs(st - primTime);
              if (diff < minDiff) {
                minDiff = diff;
                secIdx = sI;
              }
            }
          });
        } else {
          secIdx = Math.round((idx / (readings.length - 1 || 1)) * (secondaryReadings.length - 1 || 1));
        }

        if (secIdx >= 0 && Number.isFinite(secValuesByIndex[secIdx])) {
          const secVal = secValuesByIndex[secIdx];
          const secCursorX = getSecondaryX(secIdx);
          const secY = plotY + plotH - ((secVal - secMin) / secSpan) * plotH;

          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(secCursorX, secY, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#451a03';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
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

function parseSecondaryValue(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    const objId = Number(raw.slice(0, colonIdx));
    const key = raw.slice(colonIdx + 1);
    if (Number.isFinite(objId) && key) {
      return { objectId: objId, key, raw: `${objId}:${key}` };
    }
  }
  const currentObj = getSelectedObject();
  return currentObj ? { objectId: Number(currentObj.id), key: raw, raw: `${currentObj.id}:${raw}` } : null;
}

function getSecondarySelection() {
  const parsed = parseSecondaryValue(secondaryKeySelect?.value);
  if (!parsed) return null;
  const match = allObjectsKeysCache.find(
    (entry) => Number(entry.objectId) === Number(parsed.objectId) && entry.value_key === parsed.key
  );
  if (match) {
    return {
      raw: `${match.objectId}:${match.value_key}`,
      objectId: Number(match.objectId),
      objectName: match.objectName || '',
      key: match.value_key,
      label: match.label || match.value_key,
      unit: match.unit || ''
    };
  }
  const obj = objectsCache.find((o) => Number(o.id) === Number(parsed.objectId)) || getSelectedObject();
  const fallbackKey = keysCache.find((k) => k.value_key === parsed.key);
  return {
    raw: `${parsed.objectId}:${parsed.key}`,
    objectId: Number(parsed.objectId),
    objectName: obj?.name || '',
    key: parsed.key,
    label: fallbackKey?.label || parsed.key,
    unit: fallbackKey?.unit || ''
  };
}

function renderKeySelect(list, selectedKey) {
  if (!keySelect) return;
  const currentObj = getSelectedObject();
  const currentObjId = Number(currentObj?.id);

  if (!list.length) {
    keySelect.innerHTML = '';
  } else {
    keySelect.innerHTML = list.map((k) => {
      const sel = k.value_key === selectedKey ? 'selected' : '';
      const topic = k.topic ? ` [${escapeHtml(k.topic)}]` : '';
      const label = k.label ? ` (${escapeHtml(k.label)})` : '';
      const unit = k.unit ? ` [${escapeHtml(k.unit)}]` : '';
      return `<option value="${escapeHtml(k.value_key)}" ${sel}>${escapeHtml(k.value_key + topic + label + unit)}</option>`;
    }).join('');
  }

  if (secondaryKeySelect) {
    const prevParsed = parseSecondaryValue(secondaryKeySelect.value);
    const prevRaw = prevParsed ? `${prevParsed.objectId}:${prevParsed.key}` : '';

    const groupsMap = new Map();
    for (const o of objectsCache) {
      groupsMap.set(Number(o.id), { object: o, keys: [] });
    }
    for (const entry of allObjectsKeysCache) {
      const oid = Number(entry.objectId);
      if (oid === currentObjId) continue;
      if (!groupsMap.has(oid)) {
        groupsMap.set(oid, { object: { id: oid, name: entry.objectName || `Objekt ${oid}` }, keys: [] });
      }
      groupsMap.get(oid).keys.push(entry);
    }
    if (Number.isFinite(currentObjId)) {
      if (!groupsMap.has(currentObjId)) {
        groupsMap.set(currentObjId, { object: currentObj, keys: [] });
      }
      groupsMap.get(currentObjId).keys = list.map((k) => ({
        ...k,
        objectId: currentObjId,
        objectName: currentObj?.name || ''
      }));
    }

    const optgroupsHtml = [];
    const multiObject = groupsMap.size > 1;
    for (const [oid, group] of groupsMap.entries()) {
      const availableKeys = group.keys.filter(
        (k) => !(oid === currentObjId && k.value_key === selectedKey)
      );
      if (!availableKeys.length) continue;
      const optionsHtml = availableKeys.map((k) => {
        const val = `${oid}:${k.value_key}`;
        const sel = val === prevRaw ? 'selected' : '';
        const label = k.label ? ` (${k.label})` : '';
        const unit = k.unit ? ` [${k.unit}]` : '';
        const prefix = multiObject && group.object?.name ? `${group.object.name} – ` : '';
        return `<option value="${escapeHtml(val)}" ${sel}>${escapeHtml(prefix + k.value_key + label + unit)}</option>`;
      }).join('');
      optgroupsHtml.push(`<optgroup label="${escapeHtml(group.object?.name || `Objekt ${oid}`)}">${optionsHtml}</optgroup>`);
    }

    secondaryKeySelect.innerHTML = [
      '<option value="">-- Kein Vergleich (nur Primär) --</option>',
      ...optgroupsHtml
    ].join('');
  }
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
  if (editing) {
    document.getElementById('key-editor').open = true;
    requestAnimationFrame(() => keyInput?.focus());
  }
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

async function loadAllObjectsKeys() {
  if (!Array.isArray(objectsCache) || !objectsCache.length) {
    allObjectsKeysCache = [];
    return;
  }
  const perObject = await Promise.all(
    objectsCache.map(async (obj) => {
      try {
        const [keys, recentReadings] = await Promise.all([
          fetchKeys(obj.id).catch(() => []),
          fetch(`/api/objects/${obj.id}/readings?limit=30`, { signal: AbortSignal.timeout(8000) })
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => [])
        ]);
        if (Array.isArray(recentReadings)) {
          const byKey = new Map();
          for (const r of recentReadings) {
            if (!r?.value_key) continue;
            const arr = byKey.get(r.value_key) || [];
            if (arr.length < 2) arr.push(r);
            byKey.set(r.value_key, arr);
          }
          for (const [kName, pair] of byKey.entries()) {
            const latest = pair[0];
            const prev = pair[1] || null;
            const val = parseNumber(latest.value_text);
            const prevVal = prev ? parseNumber(prev.value_text) : null;
            let trend = 'stable';
            if (Number.isFinite(val) && Number.isFinite(prevVal)) {
              const diff = val - prevVal;
              if (diff > 0.05) trend = 'up';
              else if (diff < -0.05) trend = 'down';
            }
            latestKeyReadingsCache.set(`${obj.id}:${kName}`, {
              valText: latest.value_text,
              valNum: val,
              trend,
              status: 'optimal',
              ts: latest.created_at
            });
          }
        }
        return (Array.isArray(keys) ? keys : []).map((k) => ({
          ...k,
          objectId: Number(obj.id),
          objectName: obj.name
        }));
      } catch {
        return [];
      }
    })
  );
  allObjectsKeysCache = perObject.flat();
}

let keyLoadVersion = 0;
async function loadKeys(preserveSelection = true, preferredKey = '') {
  const version = ++keyLoadVersion;
  const obj = getSelectedObject();
  const selected = preferredKey || (preserveSelection ? getSelectedKey() : '');
  chartRequestController?.abort();
  lastReadingsCache = [];
  chartDataCache = [];
  drawChart([]);
  if (exportCsvBtn) exportCsvBtn.disabled = true;
  keySelect.disabled = true;
  if (!obj) {
    keysCache = [];
    allObjectsKeysCache = [];
    renderKeyList([]);
    renderKeySelect([], '');
    renderAutomationKeyOptions('');
    drawChart([]);
    setKeyFormMode(false);
    document.getElementById('graph-status').textContent = 'Lege zuerst ein Objekt an, um Messwerte anzuzeigen.';
    return;
  }

  try {
    document.getElementById('graph-status').textContent = 'Messwerte für das gewählte Objekt werden geladen …';
    const [list] = await Promise.all([
      fetchKeys(obj.id),
      loadAllObjectsKeys()
    ]);
    if (version !== keyLoadVersion) return;
    keysCache = list;
    renderKeyList(list);

    const nextKey = selected && list.some((k) => k.value_key === selected)
      ? selected
      : (list[0]?.value_key || '');

    renderKeySelect(list, nextKey);
    if (keySelect && nextKey) keySelect.value = nextKey;
    renderSensorDeck();

    setKeyFormMode(false);
    renderAutomationKeyOptions();
    await loadReadings();
  } catch (err) {
    if (version !== keyLoadVersion) return;
    keysCache = [];
    renderKeySelect([], '');
    document.getElementById('graph-status').textContent = err.message;
    document.getElementById('graph-retry').hidden = false;
    if (keyList) keyList.innerHTML = `<li>Fehler: ${escapeHtml(err.message || err)}</li>`;
  } finally {
    if (version === keyLoadVersion) keySelect.disabled = false;
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

const CMD_HISTORY_KEY = 'hydro_quick_command_history';

function getCommandHistory() {
  try {
    return JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function addCommandToHistory(label, topic, payload) {
  try {
    const list = getCommandHistory();
    list.unshift({
      label,
      topic,
      payload,
      timestamp: new Date().toISOString()
    });
    const trimmed = list.slice(0, 6);
    localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(trimmed));
    renderCommandHistory();
  } catch {}
}

function renderCommandHistory() {
  const container = document.getElementById('quick-controls-history');
  const listEl = document.getElementById('quick-history-list');
  const clearBtn = document.getElementById('quick-history-clear');
  if (!container || !listEl) return;
  const history = getCommandHistory();
  if (!history.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  listEl.innerHTML = history.map((item) => {
    const d = new Date(item.timestamp);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const payloadStr = item.payload ? ` · Payload: ${escapeHtml(item.payload)}` : '';
    return `<li style="color:#cbd5e1; display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap; background:rgba(30,41,59,0.5); padding:0.25rem 0.5rem; border-radius:0.35rem;">
      <span><strong>${escapeHtml(item.label)}</strong> <span style="color:#64748b;">(${escapeHtml(item.topic)}${payloadStr})</span></span>
      <span style="color:#38bdf8; font-variant-numeric:tabular-nums; white-space:nowrap; font-size:0.75rem;">${time} Uhr ✓</span>
    </li>`;
  }).join('');

  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = 'true';
    clearBtn.addEventListener('click', () => {
      try { localStorage.removeItem(CMD_HISTORY_KEY); } catch {}
      renderCommandHistory();
    });
  }
}

function renderQuickControls(commands) {
  const container = document.getElementById('quick-controls-buttons');
  const feedbackEl = document.getElementById('quick-controls-feedback');
  renderCommandHistory();
  if (!container) return;

  const validCmds = Array.isArray(commands) ? commands.filter((c) => (c.label || '').trim() && (c.topic || '').trim()) : [];
  if (!validCmds.length) {
    container.innerHTML = '<span class="muted-line">Keine Schnellbefehle hinterlegt. Lege unter „Einrichtung &amp; Befehle“ welche an.</span>';
    return;
  }

  container.innerHTML = validCmds.map((c, idx) => {
    const l = (c.label || '').toLowerCase();
    const icon = l.includes('pumpe') ? '🔄' : l.includes('licht') || l.includes('led') ? '💡' : l.includes('lüft') || l.includes('fan') ? '💨' : l.includes('mess') ? '📊' : '⚡';
    return `
      <button type="button" class="btn-quick-control" data-cmd-idx="${idx}" title="${escapeHtml(c.topic)}: ${escapeHtml(c.payload || '')}">
        <span class="quick-cmd-icon">${icon}</span>
        <span class="quick-cmd-label">${escapeHtml(c.label)}</span>
      </button>
    `;
  }).join('');

  container.querySelectorAll('.btn-quick-control').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.cmdIdx);
      const cmd = validCmds[idx];
      if (!cmd) return;
      btn.disabled = true;
      btn.classList.add('is-firing');
      if (feedbackEl) {
        feedbackEl.textContent = `Sende ${cmd.label} …`;
        feedbackEl.style.color = '#38bdf8';
      }
      try {
        await publishMqtt(cmd.topic, cmd.payload || '');
        addCommandToHistory(cmd.label, cmd.topic, cmd.payload || '');
        if (feedbackEl) {
          feedbackEl.textContent = `✓ ${cmd.label} gesendet!`;
          feedbackEl.style.color = '#10b981';
          setTimeout(() => { if (feedbackEl) feedbackEl.textContent = ''; }, 3500);
        }
      } catch (err) {
        if (feedbackEl) {
          feedbackEl.textContent = `Fehler: ${err.message}`;
          feedbackEl.style.color = '#ef4444';
        }
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-firing');
      }
    });
  });
}

function renderCommands(commands) {
  renderQuickControls(commands);
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

secondaryKeySelect?.addEventListener('change', () => {
  renderSensorDeck();
  loadReadings();
});
