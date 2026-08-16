function renderAutomationKeyOptions(selectedValue = '') {
  if (!automationKeySelect) return;
  if (!keysCache.length) {
    automationKeySelect.innerHTML = '<option value="">Keine Keys definiert</option>';
    return;
  }

  automationKeySelect.innerHTML = keysCache.map((key) => {
    const selected = key.value_key === selectedValue ? 'selected' : '';
    const label = key.label ? ` (${key.label})` : '';
    const unit = key.unit ? ` [${key.unit}]` : '';
    return `<option value="${escapeHtml(key.value_key)}" ${selected}>${escapeHtml(key.value_key + label + unit)}</option>`;
  }).join('');
}

function renderAutomationCommandOptions(selectedRule = null) {
  if (!automationCommandSelect) return;
  if (!currentCommands.length) {
    automationCommandSelect.innerHTML = '<option value="">Keine Befehle definiert</option>';
    return;
  }

  automationCommandSelect.innerHTML = currentCommands.map((command, index) => {
    const isSelected = selectedRule &&
      selectedRule.actionType === 'command' &&
      command.label === selectedRule.actionLabel &&
      command.topic === selectedRule.actionTopic &&
      command.payload === selectedRule.actionPayload;
    const selected = isSelected ? 'selected' : '';
    return `
      <option
        value="${index}"
        data-label="${escapeHtml(command.label)}"
        data-topic="${escapeHtml(command.topic)}"
        data-payload="${escapeHtml(command.payload)}"
        ${selected}
      >
        ${escapeHtml(command.label)}
      </option>
    `;
  }).join('');
}

function cloneAutomationAction(action) {
  return {
    actionType: action?.actionType === 'command' ? 'command' : 'custom',
    actionLabel: String(action?.actionLabel ?? '').trim(),
    actionTopic: String(action?.actionTopic ?? '').trim(),
    actionPayload: String(action?.actionPayload ?? '')
  };
}

function normalizeAutomationWeekdays(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(
    input
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6)
  )).sort((a, b) => a - b);
}

function getSelectedAutomationWeekdays() {
  return normalizeAutomationWeekdays(
    automationWeekdayInputs
      .filter((input) => input.checked)
      .map((input) => Number(input.value))
  );
}

function setSelectedAutomationWeekdays(weekdays = AUTOMATION_WEEKDAY_ORDER) {
  const normalized = normalizeAutomationWeekdays(weekdays);
  const selected = new Set(normalized.length ? normalized : AUTOMATION_WEEKDAY_ORDER);
  automationWeekdayInputs.forEach((input) => {
    input.checked = selected.has(Number(input.value));
  });
}

function buildAutomationWeekdayText(weekdays) {
  const normalized = normalizeAutomationWeekdays(weekdays);
  if (!normalized.length || normalized.length === 7) {
    return 'Taeglich';
  }

  return AUTOMATION_WEEKDAY_ORDER
    .filter((day) => normalized.includes(day))
    .map((day) => AUTOMATION_WEEKDAY_LABELS[day])
    .join(', ');
}

function renderAutomationDraftActions() {
  if (!automationActionList) return;

  if (!automationDraftActions.length) {
    automationActionList.innerHTML = '<li>Keine Aktionen hinzugefuegt</li>';
    return;
  }

  automationActionList.innerHTML = automationDraftActions.map((action, index) => {
    const label = action.actionLabel || (action.actionType === 'command' ? 'Befehl' : 'Eigene Aktion');
    const topic = action.actionTopic ? ` -> ${action.actionTopic}` : '';
    return `
      <li data-index="${index}">
        <div class="cmd-meta" style="display:grid; gap:0.5rem; min-width:0;">
          <span class="cmd-label">${escapeHtml(label)}</span>
          <span class="cmd-payload">${escapeHtml(topic)}</span>
          <span class="cmd-payload">${escapeHtml(action.actionPayload || '')}</span>
        </div>
        <button class="cmd-delete" type="button" data-action="delete-draft-action">Loeschen</button>
      </li>
    `;
  }).join('');
}

function syncAutomationFieldVisibility() {
  const triggerType = automationTriggerType?.value || 'value';
  const actionType = automationActionType?.value || 'command';

  if (automationValueFields) automationValueFields.hidden = triggerType !== 'value';
  if (automationTimeFields) automationTimeFields.hidden = triggerType !== 'time';
  if (automationCommandFields) automationCommandFields.hidden = actionType !== 'command';
  if (automationCustomFields) automationCustomFields.hidden = actionType !== 'custom';
}

function resetAutomationForm() {
  if (!automationForm) return;
  automationForm.reset();
  if (automationIdInput) automationIdInput.value = '';
  if (automationEnabled) automationEnabled.checked = true;
  if (automationTriggerType) automationTriggerType.value = 'value';
  if (automationActionType) automationActionType.value = 'command';
  if (automationCooldownInput) automationCooldownInput.value = '0';
  if (automationHysteresisInput) automationHysteresisInput.value = '';
  if (automationWindowStartInput) automationWindowStartInput.value = '';
  if (automationWindowEndInput) automationWindowEndInput.value = '';
  setSelectedAutomationWeekdays();
  automationDraftActions = [];
  renderAutomationKeyOptions('');
  renderAutomationCommandOptions();
  renderAutomationDraftActions();
  syncAutomationFieldVisibility();
}

function buildAutomationTriggerText(rule) {
  if (rule.triggerType === 'time') {
    return `Um ${rule.scheduleTime}`;
  }
  return `Wenn ${rule.valueKey} ${rule.operator} ${rule.compareValue}`;
}

function buildAutomationActionText(rule) {
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  if (!actions.length) return 'Keine Aktion';
  if (actions.length === 1) {
    const first = actions[0];
    const label = first.actionLabel ? first.actionLabel : 'Eigener MQTT-Befehl';
    return `${label} -> ${first.actionTopic}`;
  }
  return `${actions.length} Aktionen`;
}

function buildAutomationScheduleText(rule) {
  const parts = [];
  const weekdaysText = buildAutomationWeekdayText(rule.weekdays);
  if (weekdaysText !== 'Taeglich') {
    parts.push(weekdaysText);
  }
  if (rule.windowStart && rule.windowEnd) {
    parts.push(`${rule.windowStart}-${rule.windowEnd}`);
  }
  return parts.join(' | ');
}

function renderAutomationRules(list) {
  if (!automationList) return;

  if (!Array.isArray(list) || list.length === 0) {
    automationList.innerHTML = '<li>Keine Automatisierungen angelegt</li>';
    return;
  }

  automationList.innerHTML = list.map((rule) => {
    const stateLabel = rule.enabled ? 'Aktiv' : 'Pausiert';
    const stateClass = rule.enabled ? 'status-online' : 'status-offline';
    const lastFired = rule.lastFiredAt ? ` | Zuletzt: ${new Date(rule.lastFiredAt).toLocaleString()}` : '';
    const extras = [];
    if (Number(rule.cooldownSeconds) > 0) extras.push(`Cooldown ${rule.cooldownSeconds}s`);
    if (rule.hysteresisValue !== '' && rule.hysteresisValue != null) extras.push(`Hysterese ${rule.hysteresisValue}`);
    const scheduleText = buildAutomationScheduleText(rule);
    if (scheduleText) extras.push(scheduleText);
    const extraText = extras.length ? ` | ${extras.join(' | ')}` : '';
    return `
      <li data-id="${rule.id}">
        <div class="cmd-meta" style="display:grid; gap:0.5rem; min-width:0;">
          <span class="cmd-label">${escapeHtml(rule.name)}</span>
          <span class="cmd-payload">${escapeHtml(buildAutomationTriggerText(rule))}</span>
          <span class="cmd-payload">${escapeHtml(buildAutomationActionText(rule) + extraText + lastFired)}</span>
        </div>
        <button class="cmd-send ${stateClass}" type="button" data-action="toggle">${stateLabel}</button>
        <div class="cmd-action-group" style="display:flex; gap:0.5rem; min-width:0; justify-content:flex-end;">
          <button class="key-edit" type="button" data-action="test">Test</button>
          <button class="cmd-edit" type="button" data-action="edit">Bearbeiten</button>
          <button class="cmd-delete" type="button" data-action="delete">Loeschen</button>
        </div>
      </li>
    `;
  }).join('');
}

function setAutomationFormMode(rule = null) {
  if (!rule) {
    resetAutomationForm();
    return;
  }

  if (automationIdInput) automationIdInput.value = String(rule.id);
  if (automationNameInput) automationNameInput.value = rule.name || '';
  if (automationTriggerType) automationTriggerType.value = rule.triggerType || 'value';
  if (automationEnabled) automationEnabled.checked = Boolean(rule.enabled);
  if (automationCooldownInput) automationCooldownInput.value = String(rule.cooldownSeconds || 0);
  if (automationHysteresisInput) automationHysteresisInput.value = rule.hysteresisValue ?? '';
  if (automationWindowStartInput) automationWindowStartInput.value = rule.windowStart || '';
  if (automationWindowEndInput) automationWindowEndInput.value = rule.windowEnd || '';
  setSelectedAutomationWeekdays(rule.weekdays);
  if (automationActionType) automationActionType.value = 'command';
  renderAutomationKeyOptions(rule.valueKey || '');
  renderAutomationCommandOptions();
  if (automationOperator) automationOperator.value = rule.operator || '>';
  if (automationCompareInput) automationCompareInput.value = rule.compareValue || '';
  if (automationTimeInput) automationTimeInput.value = rule.scheduleTime || '';
  if (automationTopicInput) automationTopicInput.value = '';
  if (automationPayloadInput) automationPayloadInput.value = '';
  automationDraftActions = Array.isArray(rule.actions) ? rule.actions.map(cloneAutomationAction) : [];
  renderAutomationDraftActions();
  syncAutomationFieldVisibility();
}

function setCommandFormMode(editing, command = null) {
  if (!commandAdd) return;
  if (editing && command) {
    if (commandLabel) commandLabel.value = command.label || '';
    if (commandTopic) commandTopic.value = command.topic || '';
    if (commandPayload) commandPayload.value = command.payload || '';
    commandAdd.textContent = 'Befehl speichern';
    if (commandCancel) commandCancel.style.display = 'inline-flex';
  } else {
    if (commandLabel) commandLabel.value = '';
    if (commandTopic) commandTopic.value = '';
    if (commandPayload) commandPayload.value = '';
    commandAdd.textContent = 'Befehl hinzufügen';
    if (commandCancel) commandCancel.style.display = 'none';
    editingCommandIndex = null;
  }
}

function renderSelectedObject() {
  const obj = getSelectedObject();
  if (!obj) {
    currentCommands = [];
    renderCommands([]);
    return;
  }

  loadTopicCommands();
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
    await loadAutomations();
    populateThresholdInputs();
    loadHydroponicBrokerSummary();
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

async function createValueKeyForObject(objectId, valueKey, topic, label, unit) {
  const res = await fetch(`/api/objects/${objectId}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueKey, topic, label, unit })
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

async function updateValueKeyForObject(objectId, keyId, valueKey, topic, label, unit) {
  const res = await fetch(`/api/objects/${objectId}/keys/${keyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, valueKey, label, unit })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Key speichern fehlgeschlagen');
  return data;
}

async function fetchTopicCommands(objectId) {
  const res = await fetch(`/api/objects/${objectId}/commands`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Befehle laden fehlgeschlagen');
  return data;
}

async function deleteReadingsForObject(objectId) {
  const res = await fetch(`/api/objects/${objectId}/readings`, {
    method: 'DELETE'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Messwerte löschen fehlgeschlagen');
  return data;
}

function formatStorageBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function renderDatabaseStorageStatus(stats) {
  if (!databaseStorageStatus) return;
  const fileSize = formatStorageBytes(stats?.fileSizeBytes);
  const reclaimable = formatStorageBytes(stats?.reclaimableBytes);
  databaseStorageStatus.textContent = `SQLite-Datei: ${fileSize} | freigebbar: ${reclaimable}`;
}

async function loadDatabaseStorageStatus() {
  if (!databaseStorageStatus) return;
  try {
    const res = await fetch('/api/objects/maintenance/database');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Datenbankstatus konnte nicht geladen werden');
    renderDatabaseStorageStatus(data);
  } catch (err) {
    databaseStorageStatus.textContent = `Datenbankstatus: ${err.message || err}`;
  }
}

async function saveTopicCommands(objectId, commands) {
  const res = await fetch(`/api/objects/${objectId}/commands`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Befehle speichern fehlgeschlagen');
  return data;
}

async function fetchAutomationRules(objectId) {
  const res = await fetch(`/api/objects/${objectId}/automations`);
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(data.error || 'Automatisierungen laden fehlgeschlagen');
  return Array.isArray(data) ? data : [];
}

async function saveAutomationRule(objectId, payload, ruleId = null) {
  const url = ruleId
    ? `/api/objects/${objectId}/automations/${ruleId}`
    : `/api/objects/${objectId}/automations`;
  const method = ruleId ? 'PUT' : 'POST';
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Automatisierung speichern fehlgeschlagen');
  return data;
}

async function deleteAutomationRuleForObject(objectId, ruleId) {
  const res = await fetch(`/api/objects/${objectId}/automations/${ruleId}`, {
    method: 'DELETE'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Automatisierung loeschen fehlgeschlagen');
  return data;
}

async function testAutomationRuleForObject(objectId, ruleId) {
  const res = await fetch(`/api/objects/${objectId}/automations/${ruleId}/test`, {
    method: 'POST'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Automatisierung testen fehlgeschlagen');
  return data;
}

async function loadAutomations() {
  const obj = getSelectedObject();
  if (!obj) {
    automationRulesCache = [];
    renderAutomationRules([]);
    resetAutomationForm();
    return;
  }

  try {
    const list = await fetchAutomationRules(obj.id);
    automationRulesCache = list;
    renderAutomationRules(list);
    renderAutomationKeyOptions('');
    renderAutomationCommandOptions();
    syncAutomationFieldVisibility();
  } catch (err) {
    automationRulesCache = [];
    if (automationList) automationList.innerHTML = `<li>Fehler: ${err.message || err}</li>`;
  }
}

async function loadTopicCommands() {
  const obj = getSelectedObject();
  if (!obj) return;

  try {
    const data = await fetchTopicCommands(obj.id);
    currentCommands = Array.isArray(data.commands) ? data.commands : [];
    renderCommands(currentCommands);
    renderAutomationCommandOptions();
  } catch (err) {
    currentCommands = [];
    renderCommands([]);
    renderAutomationCommandOptions();
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
  setAutomationStatus('');
  renderSelectedObject();
  loadKeys(false);
  loadAutomations();
  populateThresholdInputs();
  loadHydroponicBrokerSummary();
});

readingsRefresh?.addEventListener('click', () => {
  setReadingsStatus('');
  loadReadings();
});

graphRefresh?.addEventListener('click', () => {
  setReadingsStatus('');
  loadReadings();
});

deleteReadingsBtn?.addEventListener('click', async () => {
  const obj = getSelectedObject();
  if (!obj) return;

  if (!window.confirm('Alle Messwerte für dieses Objekt wirklich löschen?')) {
    return;
  }

  setReadingsStatus('Lösche Messwerte...');
  deleteReadingsBtn.disabled = true;
  try {
    await deleteReadingsForObject(obj.id);
    await loadDatabaseStorageStatus();
    setReadingsStatus('Messwerte gelöscht.');
    await loadReadings();
  } catch (err) {
    setReadingsStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    deleteReadingsBtn.disabled = false;
  }
});

optimizeDatabaseBtn?.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Die gesamte SQLite-Datenbank jetzt optimieren? Der Server reagiert waehrenddessen kurz nicht.'
  );
  if (!confirmed) return;

  setReadingsStatus('Optimiere Datenbank ...');
  optimizeDatabaseBtn.disabled = true;
  try {
    const res = await fetch('/api/objects/maintenance/database/optimize', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error === 'database_optimization_insufficient_space'
        ? `Zu wenig freier Speicher (${formatStorageBytes(data.availableDiskBytes)} verfuegbar).`
        : data.error || 'Datenbankoptimierung fehlgeschlagen';
      throw new Error(message);
    }
    renderDatabaseStorageStatus(data.after);
    setReadingsStatus(`Datenbank optimiert. ${formatStorageBytes(data.reclaimedBytes)} freigegeben.`);
  } catch (err) {
    setReadingsStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    optimizeDatabaseBtn.disabled = false;
  }
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
  populateThresholdInputs();
  loadReadings();
});

thresholdSave?.addEventListener('click', () => {
  saveThresholdSettings();
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
  const topic = (keyTopic?.value || '').trim();
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
      await updateValueKeyForObject(obj.id, keyId, valueKey, topic, label, unit);
      setConfigStatus('Key gespeichert.');
    } else {
      await createValueKeyForObject(obj.id, valueKey, topic, label, unit);
      setConfigStatus('Key hinzugefügt.');
    }
    setKeyFormMode(false);
    await loadKeys(false);
    await loadAutomations();
  } catch (err) {
    setConfigStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    if (keySave) keySave.disabled = false;
  }
});

keyCancel?.addEventListener('click', () => {
  setKeyFormMode(false);
});

automationTriggerType?.addEventListener('change', () => {
  syncAutomationFieldVisibility();
});

automationActionType?.addEventListener('change', () => {
  syncAutomationFieldVisibility();
});

automationActionAdd?.addEventListener('click', () => {
  const actionType = automationActionType?.value || 'command';

  if (actionType === 'command') {
    const selected = automationCommandSelect?.selectedOptions?.[0];
    if (!selected || !selected.value) {
      setAutomationStatus('Bitte zuerst einen Befehl waehlen.', true);
      return;
    }
    automationDraftActions.push({
      actionType: 'command',
      actionLabel: selected.dataset.label || selected.textContent.trim(),
      actionTopic: selected.dataset.topic || '',
      actionPayload: selected.dataset.payload || ''
    });
  } else {
    const topic = (automationTopicInput?.value || '').trim();
    const payload = automationPayloadInput?.value || '';
    if (!topic) {
      setAutomationStatus('Bitte ein Topic fuer die Aktion angeben.', true);
      return;
    }
    automationDraftActions.push({
      actionType: 'custom',
      actionLabel: 'Eigener MQTT-Befehl',
      actionTopic: topic,
      actionPayload: payload
    });
    if (automationTopicInput) automationTopicInput.value = '';
    if (automationPayloadInput) automationPayloadInput.value = '';
  }

  setAutomationStatus('');
  renderAutomationDraftActions();
});

automationCancel?.addEventListener('click', () => {
  resetAutomationForm();
  setAutomationStatus('');
});

automationForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const obj = getSelectedObject();
  if (!obj) return;

  const triggerType = automationTriggerType?.value || 'value';
  const ruleId = Number(automationIdInput?.value);
  const isEdit = Number.isFinite(ruleId) && ruleId > 0;
  const payload = {
    name: (automationNameInput?.value || '').trim(),
    enabled: Boolean(automationEnabled?.checked),
    triggerType,
    valueKey: triggerType === 'value' ? (automationKeySelect?.value || '').trim() : '',
    operator: triggerType === 'value' ? (automationOperator?.value || '').trim() : '',
    compareValue: triggerType === 'value' ? (automationCompareInput?.value || '').trim() : '',
    scheduleTime: triggerType === 'time' ? (automationTimeInput?.value || '').trim() : '',
    weekdays: getSelectedAutomationWeekdays(),
    windowStart: (automationWindowStartInput?.value || '').trim(),
    windowEnd: (automationWindowEndInput?.value || '').trim(),
    cooldownSeconds: (automationCooldownInput?.value || '0').trim(),
    hysteresisValue: triggerType === 'value' ? (automationHysteresisInput?.value || '').trim() : '',
    actions: automationDraftActions.map(cloneAutomationAction)
  };

  if (!payload.name) {
    setAutomationStatus('Name fehlt.', true);
    return;
  }

  if (!payload.actions.length) {
    setAutomationStatus('Bitte mindestens eine Aktion hinzufuegen.', true);
    return;
  }

  if (!payload.weekdays.length) {
    setAutomationStatus('Bitte mindestens einen Wochentag auswaehlen.', true);
    return;
  }

  if ((payload.windowStart && !payload.windowEnd) || (!payload.windowStart && payload.windowEnd)) {
    setAutomationStatus('Bitte Start und Ende fuer das Zeitfenster angeben.', true);
    return;
  }

  setAutomationStatus(isEdit ? 'Speichere Regel ...' : 'Lege Regel an ...');
  try {
    await saveAutomationRule(obj.id, payload, isEdit ? ruleId : null);
    setAutomationStatus(isEdit ? 'Regel gespeichert.' : 'Regel angelegt.');
    resetAutomationForm();
    await loadAutomations();
  } catch (err) {
    setAutomationStatus(`Fehler: ${err.message || err}`, true);
  }
});

automationList?.addEventListener('click', async (e) => {
  const button = e.target?.closest('button[data-action]');
  if (!button) return;

  const obj = getSelectedObject();
  if (!obj) return;

  const li = button.closest('li');
  const ruleId = Number(li?.getAttribute('data-id'));
  if (!Number.isFinite(ruleId)) return;

  const rule = automationRulesCache.find((entry) => Number(entry.id) === ruleId);
  if (!rule) return;

  const action = button.dataset.action;
  if (action === 'edit') {
    setAutomationFormMode(rule);
    setAutomationStatus('');
    return;
  }

  if (action === 'toggle') {
    try {
      await saveAutomationRule(obj.id, { ...rule, enabled: !rule.enabled }, rule.id);
      await loadAutomations();
      setAutomationStatus(rule.enabled ? 'Regel pausiert.' : 'Regel aktiviert.');
    } catch (err) {
      setAutomationStatus(`Fehler: ${err.message || err}`, true);
    }
    return;
  }

  if (action === 'test') {
    button.disabled = true;
    try {
      const result = await testAutomationRuleForObject(obj.id, rule.id);
      const failedText = Number(result.failedCount) > 0 ? `, ${result.failedCount} fehlgeschlagen` : '';
      setAutomationStatus(`Test gesendet: ${result.sentCount} Aktion(en)${failedText}.`);
    } catch (err) {
      setAutomationStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (action === 'delete') {
    try {
      await deleteAutomationRuleForObject(obj.id, rule.id);
      if (Number(automationIdInput?.value) === rule.id) {
        resetAutomationForm();
      }
      await loadAutomations();
      setAutomationStatus('Regel geloescht.');
    } catch (err) {
      setAutomationStatus(`Fehler: ${err.message || err}`, true);
    }
  }
});

automationActionList?.addEventListener('click', (e) => {
  const button = e.target?.closest('button[data-action="delete-draft-action"]');
  if (!button) return;

  const li = button.closest('li');
  const index = Number(li?.getAttribute('data-index'));
  if (!Number.isFinite(index)) return;

  automationDraftActions = automationDraftActions.filter((_, i) => i !== index);
  renderAutomationDraftActions();
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
      await loadAutomations();
    } catch (err) {
      setConfigStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      delBtn.disabled = false;
    }
  }
});

// Command hinzufügen / speichern
commandForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const obj = getSelectedObject();
  if (!obj) return;

  const label = (commandLabel?.value || '').trim();
  const payload = (commandPayload?.value || '');
  const topic = (commandTopic?.value || '').trim();

  if (!label) {
    setConfigStatus('Button-Name fehlt.', true);
    return;
  }
  if (!topic) {
    setConfigStatus('Topic fehlt.', true);
    return;
  }

  const nextCommands = [...currentCommands];
  if (editingCommandIndex !== null && editingCommandIndex >= 0 && editingCommandIndex < nextCommands.length) {
    nextCommands[editingCommandIndex] = { label, payload, topic };
  } else {
    nextCommands.push({ label, payload, topic });
  }

  setConfigStatus('Speichere Befehle ...');

  const addBtn = document.getElementById('command-add');
  if (addBtn) addBtn.disabled = true;

  try {
    await saveTopicCommands(obj.id, nextCommands);
    currentCommands = nextCommands;
    renderCommands(currentCommands);
    renderAutomationCommandOptions();
    setConfigStatus(editingCommandIndex !== null ? 'Befehl aktualisiert.' : 'Befehl hinzugefügt.');
    setCommandFormMode(false);
    await loadAutomations();
  } catch (err) {
    setConfigStatus(`Fehler: ${err.message || err}`, true);
  } finally {
    if (addBtn) addBtn.disabled = false;
  }
});

// Command senden / bearbeiten / löschen
commandList?.addEventListener('click', async (e) => {
  const obj = getSelectedObject();
  if (!obj) return;

  const editBtn = e.target?.closest('.cmd-edit');
  const sendBtn = e.target?.closest('.cmd-send');
  const delBtn = e.target?.closest('.cmd-delete');
  if (!editBtn && !sendBtn && !delBtn) return;

  const li = e.target.closest('li');
  const idx = Number(li?.getAttribute('data-index'));
  if (!Number.isFinite(idx)) return;

  if (editBtn) {
    const cmd = currentCommands?.[idx];
    if (!cmd) return;
    setCommandFormMode(true, cmd);
    editingCommandIndex = idx;
    return;
  }

  if (sendBtn) {
    const cmd = currentCommands?.[idx];
    const topic = (cmd?.topic || '').trim();
    if (!topic) {
      setConfigStatus('Bitte Topic im Befehl angeben.', true);
      return;
    }
    sendBtn.disabled = true;
    setConfigStatus('Sende ...');
    try {
      await publishMqtt(topic, cmd?.payload ?? '');
      setConfigStatus('Gesendet.');
    } catch (err) {
      setConfigStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      sendBtn.disabled = false;
    }
    return;
  }

  if (delBtn) {
    delBtn.disabled = true;
    setConfigStatus('Lösche ...');
    try {
      const nextCommands = (currentCommands || []).filter((_, i) => i !== idx);
      await saveTopicCommands(obj.id, nextCommands);
      currentCommands = nextCommands;
      renderCommands(currentCommands);
      renderAutomationCommandOptions();
      setConfigStatus('Gelöscht.');
      if (editingCommandIndex === idx) {
        setCommandFormMode(false);
      }
      await loadAutomations();
    } catch (err) {
      setConfigStatus(`Fehler: ${err.message || err}`, true);
    } finally {
      delBtn.disabled = false;
    }
  }
});

commandCancel?.addEventListener('click', () => {
  setCommandFormMode(false);
});

resetAutomationForm();
loadObjects();
loadDatabaseStorageStatus();
setupAutoRefresh();
