const elements = {
  livePower: document.getElementById("energy-live-power"),
  onlineBadge: document.getElementById("energy-online-badge"),
  lastUpdate: document.getElementById("energy-last-update"),
  today: document.getElementById("energy-today"),
  costToday: document.getElementById("energy-cost-today"),
  dial: document.getElementById("energy-dial"),
  power: document.getElementById("energy-power"),
  voltage: document.getElementById("energy-voltage"),
  current: document.getElementById("energy-current"),
  factor: document.getElementById("energy-factor"),
  priceHint: document.getElementById("energy-price-hint"),
  balanceToday: document.getElementById("energy-balance-today"),
  balanceTodayCost: document.getElementById("energy-balance-today-cost"),
  yesterday: document.getElementById("energy-yesterday"),
  yesterdayCost: document.getElementById("energy-yesterday-cost"),
  total: document.getElementById("energy-total"),
  totalSince: document.getElementById("energy-total-since"),
  peak: document.getElementById("energy-peak"),
  average: document.getElementById("energy-average"),
  apparent: document.getElementById("energy-apparent"),
  reactive: document.getElementById("energy-reactive"),
  voltageRange: document.getElementById("energy-voltage-range"),
  samples: document.getElementById("energy-samples"),
  topic: document.getElementById("energy-topic"),
  startTime: document.getElementById("energy-start-time"),
  sourceTime: document.getElementById("energy-source-time"),
  sourceStatus: document.getElementById("energy-source-status"),
  topicForm: document.getElementById("energy-topic-form"),
  topicInput: document.getElementById("energy-topic-input"),
  topicSave: document.getElementById("energy-topic-save"),
  topicStatus: document.getElementById("energy-topic-status"),
  chart: document.getElementById("energy-power-chart"),
  chartEmpty: document.getElementById("energy-chart-empty"),
  victronOnlineBadge: document.getElementById("victron-online-badge"),
  victronPanelPower: document.getElementById("victron-panel-power"),
  victronYieldToday: document.getElementById("victron-yield-today"),
  victronYieldTotal: document.getElementById("victron-yield-total"),
  victronYieldTotalSince: document.getElementById("victron-yield-total-since"),
  victronBatteryVoltage: document.getElementById("victron-battery-voltage"),
  victronBatteryCurrent: document.getElementById("victron-battery-current"),
  victronChargerState: document.getElementById("victron-charger-state"),
  victronErrorCode: document.getElementById("victron-error-code"),
  victronPeakToday: document.getElementById("victron-peak-today"),
  victronAverageToday: document.getElementById("victron-average-today"),
  victronVoltageRange: document.getElementById("victron-voltage-range"),
  victronLoadCurrent: document.getElementById("victron-load-current"),
  victronTopic: document.getElementById("victron-topic"),
  victronSourceStatus: document.getElementById("victron-source-status"),
  victronRssi: document.getElementById("victron-rssi"),
  victronLastUpdate: document.getElementById("victron-last-update"),
  victronChart: document.getElementById("victron-power-chart"),
  victronChartEmpty: document.getElementById("victron-chart-empty"),
  victronBatteryVisual: document.getElementById("victron-battery-visual"),
  victronBatteryFill: document.getElementById("victron-battery-fill"),
  victronBatterySoc: document.getElementById("victron-battery-soc"),
  victronBatterySocNote: document.getElementById("victron-battery-soc-note"),
  victronBatteryFlow: document.getElementById("victron-battery-flow"),
  victronBatteryPower: document.getElementById("victron-battery-power"),
  victronChargeDescription: document.getElementById("victron-charge-description"),
  victronChargeStages: document.getElementById("victron-charge-stages"),
  victronSocProfileSummary: document.getElementById("victron-soc-profile-summary"),
  victronSocSettingsOpen: document.getElementById("victron-soc-settings-open"),
  victronSocDialog: document.getElementById("victron-soc-dialog"),
  victronSocForm: document.getElementById("victron-soc-form"),
  victronSocSettingsClose: document.getElementById("victron-soc-settings-close"),
  victronSocSettingsCancel: document.getElementById("victron-soc-settings-cancel"),
  victronSocSettingsSave: document.getElementById("victron-soc-settings-save"),
  victronSocEnabled: document.getElementById("victron-soc-enabled"),
  victronSocProfile: document.getElementById("victron-soc-profile"),
  victronSocSystemVoltage: document.getElementById("victron-soc-system-voltage"),
  victronSocUseCustom: document.getElementById("victron-soc-use-custom"),
  victronSocCustomFields: document.getElementById("victron-soc-custom-fields"),
  victronSocEmptyVoltage: document.getElementById("victron-soc-empty-voltage"),
  victronSocFullVoltage: document.getElementById("victron-soc-full-voltage"),
  victronSocProfileName: document.getElementById("victron-soc-profile-name"),
  victronSocProfileDescription: document.getElementById("victron-soc-profile-description"),
  victronSocPreviewRange: document.getElementById("victron-soc-preview-range"),
  victronSocPreviewSystem: document.getElementById("victron-soc-preview-system"),
  victronSocPreviewResult: document.getElementById("victron-soc-preview-result"),
  victronSocSettingsStatus: document.getElementById("victron-soc-settings-status"),
  victronMqttCount: document.getElementById("victron-mqtt-count"),
  victronMqttValues: document.getElementById("victron-mqtt-values"),
  layoutGrid: document.getElementById("energy-layout-grid"),
  layoutReset: document.getElementById("energy-layout-reset"),
  layoutStatus: document.getElementById("energy-layout-status"),
  customizer: document.getElementById("energy-customizer"),
  customizerTrigger: document.getElementById("energy-customizer-trigger"),
  customizerClose: document.getElementById("energy-customizer-close"),
  customizerDone: document.getElementById("energy-customizer-done"),
  customizerBackdrop: document.getElementById("energy-customizer-backdrop"),
  customizerList: document.getElementById("energy-customizer-list"),
  error: document.getElementById("energy-error"),
};

let selectedPeriod = "24h";
let latestHistory = [];
let selectedVictronPeriod = "24h";
let latestVictronHistory = [];
let latestVictronVoltage = null;
let latestVictronEstimation = null;
let victronSocCustomRangeDirty = false;
let layoutEditMode = false;
let draggedLayoutId = null;
let draggedCustomizerId = null;
let layoutSaveChain = Promise.resolve();

const defaultEnergyLayout = [
  { id: "live-values", width: "full", visible: true, collapsed: false },
  { id: "energy-balance", width: "full", visible: true, collapsed: false },
  { id: "consumption-chart", width: "full", visible: true, collapsed: false },
  { id: "victron", width: "full", visible: true, collapsed: false },
  { id: "meter-details", width: "full", visible: true, collapsed: false },
];
let energyLayout = defaultEnergyLayout.map((entry) => ({ ...entry }));

const numberFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const currencyFormat = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

const fallbackVictronBatteryProfiles = [
  {
    id: "lifepo4",
    label: "LiFePO4",
    description: "Lithium-Eisenphosphat, 4S / 8S / 12S / 16S",
    nominalBaseVoltageV: 12.8,
    emptyBaseVoltageV: 11.2,
    fullBaseVoltageV: 13.5,
  },
  {
    id: "agm",
    label: "AGM / Blei",
    description: "Geschlossene 12-V-Bleibatterie",
    nominalBaseVoltageV: 12,
    emptyBaseVoltageV: 11.8,
    fullBaseVoltageV: 12.8,
  },
  {
    id: "gel",
    label: "Gel",
    description: "12-V-Gelbatterie",
    nominalBaseVoltageV: 12,
    emptyBaseVoltageV: 11.8,
    fullBaseVoltageV: 12.85,
  },
  {
    id: "custom",
    label: "Frei konfiguriert",
    description: "Eigene absolute Leer- und Vollspannung",
    nominalBaseVoltageV: 12,
    emptyBaseVoltageV: 11,
    fullBaseVoltageV: 14,
  },
];
let victronBatteryProfiles = fallbackVictronBatteryProfiles;

function number(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return numeric.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function dateTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("de-DE");
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function getLayoutSection(id) {
  return elements.layoutGrid?.querySelector(`[data-layout-id="${id}"]`) || null;
}

function createLayoutControls(section) {
  if (section.querySelector(":scope > .energy-layout-controls")) return;
  const controls = document.createElement("div");
  controls.className = "energy-layout-controls";
  const title = section.dataset.layoutTitle || section.dataset.layoutId;
  controls.innerHTML = `
    <button class="energy-layout-edit-only energy-layout-drag" type="button" data-layout-action="drag" draggable="true" title="Widget ziehen" aria-label="${title} verschieben">Verschieben</button>
    <strong class="energy-layout-widget-title">${title}</strong>
    <button class="energy-layout-collapse" type="button" data-layout-action="collapse" aria-expanded="true">Einklappen</button>
  `;
  section.prepend(controls);
}

function renderCustomizerList() {
  if (!elements.customizerList) return;
  elements.customizerList.innerHTML = energyLayout.map((entry, index) => {
    const section = getLayoutSection(entry.id);
    const title = section?.dataset.layoutTitle || entry.id;
    const visibilityLabel = entry.visible ? "Sichtbar" : "Ausgeblendet";
    return `
      <article class="energy-customizer-item${entry.visible ? "" : " is-hidden"}" data-customizer-id="${entry.id}">
        <div class="energy-customizer-item-main">
          <button class="energy-customizer-drag" type="button" draggable="true" title="Ziehen zum Sortieren" aria-label="${title} ziehen">Ziehen</button>
          <div><strong>${title}</strong><small>${entry.width === "half" ? "Kompakte Breite" : "Volle Breite"}</small></div>
          <button class="energy-customizer-visibility${entry.visible ? " is-on" : ""}" type="button" data-customizer-action="visibility" aria-pressed="${entry.visible}">${visibilityLabel}</button>
        </div>
        <div class="energy-customizer-item-actions">
          <button type="button" data-customizer-action="width">${entry.width === "half" ? "Breit machen" : "Kompakt machen"}</button>
          <button type="button" data-customizer-action="collapse">${entry.collapsed ? "Ausklappen" : "Einklappen"}</button>
          <button type="button" data-customizer-action="up" ${index === 0 ? "disabled" : ""}>Hoch</button>
          <button type="button" data-customizer-action="down" ${index === energyLayout.length - 1 ? "disabled" : ""}>Runter</button>
        </div>
      </article>
    `;
  }).join("");
}

function setLayoutStatus(message, state = "saved") {
  setText(elements.layoutStatus, message);
  const stateElement = elements.layoutStatus?.closest(".energy-customizer-save-state");
  if (!stateElement) return;
  stateElement.classList.toggle("is-saving", state === "saving");
  stateElement.classList.toggle("is-error", state === "error");
}

function setCustomizerOpen(open) {
  layoutEditMode = open;
  elements.customizer?.setAttribute("aria-hidden", String(!open));
  elements.customizerTrigger?.setAttribute("aria-expanded", String(open));
  if (elements.customizerBackdrop) elements.customizerBackdrop.hidden = !open;
  document.body.classList.toggle("energy-customizer-open", open);
  applyEnergyLayout();
  if (open) {
    setTimeout(() => elements.customizerClose?.focus(), 0);
  } else if (elements.customizer?.contains(document.activeElement)) {
    elements.customizerTrigger?.focus();
  }
}

function applyEnergyLayout() {
  for (const entry of energyLayout) {
    const section = getLayoutSection(entry.id);
    if (!section) continue;
    createLayoutControls(section);
    elements.layoutGrid.append(section);
    section.classList.toggle("energy-layout-half", entry.width === "half");
    section.classList.toggle("energy-layout-full", entry.width !== "half");
    section.classList.toggle("energy-layout-hidden-section", !entry.visible);
    section.classList.toggle("energy-layout-collapsed", entry.collapsed === true);
    section.classList.remove("is-dragging");
    const widthButton = section.querySelector('[data-layout-action="width"]');
    if (widthButton) widthButton.textContent = entry.width === "half" ? "Volle Breite" : "Halbe Breite";
    const collapseButton = section.querySelector('[data-layout-action="collapse"]');
    if (collapseButton) {
      collapseButton.textContent = entry.collapsed ? "Ausklappen" : "Einklappen";
      collapseButton.setAttribute("aria-expanded", String(!entry.collapsed));
    }
  }

  document.body.classList.toggle("energy-layout-editing", layoutEditMode);
  renderCustomizerList();
  requestAnimationFrame(() => {
    drawChart();
    drawVictronChart();
  });
}

function saveEnergyLayout() {
  const snapshot = energyLayout.map((entry) => ({ ...entry }));
  setLayoutStatus("Aenderungen werden gespeichert ...", "saving");
  layoutSaveChain = layoutSaveChain.then(async () => {
    const response = await fetch("/energy/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ layout: snapshot }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
    setLayoutStatus("Gespeichert", "saved");
  }).catch((error) => {
    setLayoutStatus(`Speichern fehlgeschlagen: ${error.message}`, "error");
  });
  return layoutSaveChain;
}

async function loadEnergyLayout() {
  try {
    const response = await fetch("/energy/layout", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true || !Array.isArray(data.layout)) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    energyLayout = data.layout;
    setLayoutStatus("Gespeicherte Ansicht geladen", "saved");
  } catch (error) {
    setLayoutStatus(`Standardansicht aktiv: ${error.message}`, "error");
  }
  applyEnergyLayout();
}

function moveLayoutSection(id, direction) {
  const index = energyLayout.findIndex((entry) => entry.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= energyLayout.length) return;
  const [entry] = energyLayout.splice(index, 1);
  energyLayout.splice(target, 0, entry);
  applyEnergyLayout();
  saveEnergyLayout();
}

function updateLayoutFromDom() {
  const ids = [...elements.layoutGrid.querySelectorAll("[data-layout-id]")]
    .map((section) => section.dataset.layoutId);
  energyLayout.sort((left, right) => ids.indexOf(left.id) - ids.indexOf(right.id));
  applyEnergyLayout();
  saveEnergyLayout();
}

function updateLayoutFromCustomizerDom() {
  const ids = [...elements.customizerList.querySelectorAll("[data-customizer-id]")]
    .map((item) => item.dataset.customizerId);
  energyLayout.sort((left, right) => ids.indexOf(left.id) - ids.indexOf(right.id));
  applyEnergyLayout();
  saveEnergyLayout();
}

function formatAxisTime(timestamp, period) {
  const date = new Date(timestamp);
  if (period === "1h" || period === "24h") {
    return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function drawPowerChart(canvas, emptyElement, entries, averageKey, peakKey, color, fillColor, period) {
  if (!canvas) return;
  const points = entries.filter((entry) => Number.isFinite(Number(entry[averageKey])));
  emptyElement.hidden = points.length > 1;

  const width = Math.max(320, canvas.clientWidth);
  const height = Math.max(260, canvas.clientHeight);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (points.length < 2) return;

  const padding = { top: 25, right: 22, bottom: 45, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxPower = Math.max(10, ...points.map((entry) => Number(entry[peakKey] || entry[averageKey])));
  const chartMax = Math.ceil(maxPower / 10) * 10;

  context.font = "12px IBM Plex Sans, sans-serif";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    const value = chartMax - (chartMax / 4) * index;
    context.strokeStyle = "rgba(145, 167, 197, 0.14)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = "#91a7c5";
    context.textAlign = "right";
    context.fillText(`${number(value, 0)} W`, padding.left - 10, y);
  }

  const xFor = (index) => padding.left + (index / (points.length - 1)) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - (Number(value) / chartMax) * plotHeight;
  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
  gradient.addColorStop(0, fillColor);
  gradient.addColorStop(1, "rgba(4, 10, 19, 0.01)");

  context.beginPath();
  points.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry[averageKey]);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.lineTo(xFor(points.length - 1), padding.top + plotHeight);
  context.lineTo(xFor(0), padding.top + plotHeight);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  points.forEach((entry, index) => {
    const x = xFor(index);
    const y = yFor(entry[averageKey]);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.stroke();

  context.fillStyle = "#ff7f7f";
  points.forEach((entry, index) => {
    const average = Number(entry[averageKey]);
    const peak = Number(entry[peakKey]);
    if (!Number.isFinite(peak) || peak <= average) return;
    const x = xFor(index);
    const y = yFor(peak);
    roundedRect(context, x - 1.5, y - 1.5, 3, Math.max(3, yFor(average) - y), 2);
  });

  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  context.fillStyle = "#91a7c5";
  context.textBaseline = "top";
  labelIndexes.forEach((pointIndex, index) => {
    context.textAlign = index === 0 ? "left" : index === labelIndexes.length - 1 ? "right" : "center";
    context.fillText(formatAxisTime(points[pointIndex].timestamp, period), xFor(pointIndex), height - padding.bottom + 14);
  });
}

function drawChart() {
  drawPowerChart(
    elements.chart,
    elements.chartEmpty,
    latestHistory,
    "powerW",
    "peakPowerW",
    "#ffbe5c",
    "rgba(255, 190, 92, 0.35)",
    selectedPeriod
  );
}

function drawVictronChart() {
  drawPowerChart(
    elements.victronChart,
    elements.victronChartEmpty,
    latestVictronHistory,
    "panelPowerW",
    "peakPanelPowerW",
    "#63d8cf",
    "rgba(99, 216, 207, 0.32)",
    selectedVictronPeriod
  );
}

const chargerStateLabels = {
  off: "Aus",
  low_power: "Niedrigleistung",
  fault: "Stoerung",
  bulk: "Bulk",
  absorption: "Absorption",
  float: "Float",
  storage: "Lagerung",
  equalize: "Ausgleich",
  inverting: "Wechselrichter",
  power_supply: "Netzteil",
  external_control: "Extern gesteuert",
};

const victronStatusLabels = {
  ready: "BLE-Daten werden empfangen",
  waiting: "Wartet auf Victron BLE-Daten",
  stale: "Victron BLE-Daten sind veraltet",
  not_configured: "Victron ist im DFR1154 nicht konfiguriert",
  init_error: "Victron BLE konnte nicht gestartet werden",
  disabled: "Victron BLE ist deaktiviert",
};

const victronMqttLabels = {
  age_seconds: "Alter der BLE-Messung",
  battery_current_a: "Batteriestrom",
  battery_percentage: "Batterie-SOC",
  battery_soc: "Batterie-SOC",
  battery_soc_percent: "Batterie-SOC",
  battery_state_of_charge: "Batterie-SOC",
  battery_voltage_v: "Batteriespannung",
  ble_status: "BLE-Status",
  charger_state: "Ladephase",
  charger_state_id: "Ladephasen-ID",
  configured: "Konfiguriert",
  error_code: "Fehlercode",
  json: "Kompletter JSON-Datensatz",
  load_current_a: "Laststrom",
  panel_power_w: "PV-Leistung",
  rssi: "BLE-Signalstaerke",
  soc: "Batterie-SOC",
  soc_percent: "Batterie-SOC",
  state_of_charge: "Batterie-SOC",
  yield_today_wh: "Tagesertrag",
};

function getVictronBatteryProfile(profileId) {
  return victronBatteryProfiles.find((profile) => profile.id === profileId)
    || fallbackVictronBatteryProfiles.find((profile) => profile.id === profileId)
    || fallbackVictronBatteryProfiles[0];
}

function detectVictronSystemFactor(profile, selectedSystem, batteryVoltageV) {
  if (selectedSystem !== "auto") return { 12: 1, 24: 2, 36: 3, 48: 4 }[selectedSystem] || 1;
  const voltage = Number(batteryVoltageV);
  if (!Number.isFinite(voltage) || voltage <= 0) {
    const detected = Number(latestVictronEstimation?.detectedSystemVoltage);
    return { 12: 1, 24: 2, 36: 3, 48: 4 }[detected] || 1;
  }
  return [1, 2, 3, 4].reduce((best, factor) => {
    const bestDistance = Math.abs(voltage - profile.nominalBaseVoltageV * best);
    const distance = Math.abs(voltage - profile.nominalBaseVoltageV * factor);
    return distance < bestDistance ? factor : best;
  }, 1);
}

function readSocVoltageInput(element) {
  if (!element || element.value.trim() === "") return null;
  const value = Number(element.value);
  return Number.isFinite(value) ? value : null;
}

function updateVictronSocFormPreview() {
  if (!elements.victronSocProfile) return;
  const profile = getVictronBatteryProfile(elements.victronSocProfile.value);
  const autoOption = elements.victronSocSystemVoltage.querySelector('option[value="auto"]');
  if (autoOption) autoOption.textContent = "Automatisch erkennen";
  [["12", 1], ["24", 2], ["36", 3], ["48", 4]].forEach(([value, factor]) => {
    const option = elements.victronSocSystemVoltage.querySelector(`option[value="${value}"]`);
    if (!option) return;
    const nominalVoltageV = profile.nominalBaseVoltageV * factor;
    option.textContent = profile.id === "lifepo4"
      ? `${value}-V-System / ${number(nominalVoltageV, 1)} V (${4 * factor}S)`
      : `${value}-V-System`;
  });
  const isCustomProfile = profile.id === "custom";
  if (isCustomProfile) elements.victronSocUseCustom.checked = true;
  elements.victronSocUseCustom.disabled = isCustomProfile;

  const useCustomRange = elements.victronSocUseCustom.checked;
  if (elements.victronSocCustomFields) elements.victronSocCustomFields.hidden = !useCustomRange;
  elements.victronSocEmptyVoltage.required = useCustomRange;
  elements.victronSocFullVoltage.required = useCustomRange;
  const systemVoltage = elements.victronSocSystemVoltage.value;
  const factor = detectVictronSystemFactor(profile, systemVoltage, latestVictronVoltage);
  const presetEmpty = profile.emptyBaseVoltageV * factor;
  const presetFull = profile.fullBaseVoltageV * factor;
  const emptyVoltageV = useCustomRange
    ? readSocVoltageInput(elements.victronSocEmptyVoltage)
    : presetEmpty;
  const fullVoltageV = useCustomRange
    ? readSocVoltageInput(elements.victronSocFullVoltage)
    : presetFull;
  const invalidCustomRange = useCustomRange
    && emptyVoltageV !== null
    && fullVoltageV !== null
    && fullVoltageV - emptyVoltageV < 0.2;
  elements.victronSocFullVoltage.setCustomValidity(
    invalidCustomRange ? "Die Vollspannung muss mindestens 0,2 V ueber der Leerspannung liegen." : ""
  );

  setText(elements.victronSocProfileName, profile.label);
  setText(elements.victronSocProfileDescription, profile.description);
  setText(
    elements.victronSocPreviewRange,
    emptyVoltageV !== null && fullVoltageV !== null
      ? `${number(emptyVoltageV, 2)} - ${number(fullVoltageV, 2)} V`
      : "Spannungsgrenzen eingeben"
  );

  const nominalVoltageV = profile.nominalBaseVoltageV * factor;
  const detectionLabel = systemVoltage === "auto" ? "automatisch erkannt" : "fest ausgewaehlt";
  setText(
    elements.victronSocPreviewSystem,
    `${profile.label} ${number(nominalVoltageV, 1)} V ${detectionLabel}${useCustomRange ? " | eigene Grenzen" : ""}`
  );
  const voltage = Number(latestVictronVoltage);
  const canPreview = elements.victronSocEnabled.checked
    && Number.isFinite(voltage)
    && emptyVoltageV !== null
    && fullVoltageV !== null
    && fullVoltageV > emptyVoltageV;
  const previewSoc = canPreview
    ? Math.max(0, Math.min(100, ((voltage - emptyVoltageV) / (fullVoltageV - emptyVoltageV)) * 100))
    : null;
  setText(
    elements.victronSocPreviewResult,
    elements.victronSocEnabled.checked === false
      ? "Schaetzung deaktiviert"
      : previewSoc === null
        ? "Noch keine Batteriespannung"
        : `${number(voltage, 2)} V ergibt etwa ${number(previewSoc, 0)} %`
  );
}

function populateVictronSocForm(estimation) {
  if (!estimation || !elements.victronSocForm) return;
  if (Array.isArray(estimation.availableProfiles) && estimation.availableProfiles.length) {
    victronBatteryProfiles = estimation.availableProfiles;
  }

  elements.victronSocEnabled.checked = estimation.enabled !== false;
  elements.victronSocProfile.value = getVictronBatteryProfile(estimation.profile).id;
  elements.victronSocSystemVoltage.value = ["auto", "12", "24", "36", "48"].includes(String(estimation.systemVoltage))
    ? String(estimation.systemVoltage)
    : "auto";
  elements.victronSocUseCustom.checked = estimation.useCustomRange === true;
  victronSocCustomRangeDirty = estimation.useCustomRange === true;
  elements.victronSocEmptyVoltage.value = Number.isFinite(Number(estimation.emptyVoltageV))
    ? Number(estimation.emptyVoltageV).toFixed(2)
    : "";
  elements.victronSocFullVoltage.value = Number.isFinite(Number(estimation.fullVoltageV))
    ? Number(estimation.fullVoltageV).toFixed(2)
    : "";
  updateVictronSocFormPreview();
}

function renderVictronSocSettings(estimation) {
  if (!estimation) return;
  latestVictronEstimation = estimation;
  if (Array.isArray(estimation.availableProfiles) && estimation.availableProfiles.length) {
    victronBatteryProfiles = estimation.availableProfiles;
  }

  const summary = estimation.enabled
    ? `${estimation.profileLabel} | ${number(estimation.nominalVoltageV, 1)} V | ${number(estimation.emptyVoltageV, 2)} - ${number(estimation.fullVoltageV, 2)} V`
    : "Spannungs-Schaetzung deaktiviert";
  setText(elements.victronSocProfileSummary, summary);
  if (!elements.victronSocDialog?.open) populateVictronSocForm(estimation);
}

function openVictronSocDialog() {
  if (!elements.victronSocDialog) return;
  populateVictronSocForm(latestVictronEstimation);
  setText(elements.victronSocSettingsStatus, "");
  if (typeof elements.victronSocDialog.showModal === "function") {
    if (!elements.victronSocDialog.open) elements.victronSocDialog.showModal();
  } else {
    elements.victronSocDialog.setAttribute("open", "");
  }
}

function closeVictronSocDialog() {
  if (!elements.victronSocDialog) return;
  if (typeof elements.victronSocDialog.close === "function" && elements.victronSocDialog.open) {
    elements.victronSocDialog.close();
  } else {
    elements.victronSocDialog.removeAttribute("open");
  }
}

function formatTopicAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "Zeit unbekannt";
  if (value < 2) return "gerade eben";
  if (value < 60) return `vor ${value} s`;
  if (value < 3600) return `vor ${Math.floor(value / 60)} min`;
  if (value < 86400) return `vor ${Math.floor(value / 3600)} h`;
  return `vor ${Math.floor(value / 86400)} d`;
}

function renderVictronMqttTopics(entries) {
  const topics = Array.isArray(entries) ? entries : [];
  setText(elements.victronMqttCount, `${topics.length} ${topics.length === 1 ? "Topic" : "Topics"}`);
  if (!elements.victronMqttValues) return;
  elements.victronMqttValues.replaceChildren();

  if (!topics.length) {
    const empty = document.createElement("span");
    empty.className = "victron-mqtt-empty";
    empty.textContent = "Noch keine Victron MQTT-Werte empfangen.";
    elements.victronMqttValues.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  topics.forEach((entry) => {
    const row = document.createElement("div");
    const identity = document.createElement("span");
    const label = document.createElement("strong");
    const topic = document.createElement("code");
    const measurement = document.createElement("span");
    const value = document.createElement("strong");
    const age = document.createElement("small");

    label.textContent = victronMqttLabels[entry.key] || entry.key;
    topic.textContent = entry.topic;
    value.textContent = entry.value;
    age.textContent = formatTopicAge(entry.ageSeconds);
    identity.append(label, topic);
    measurement.append(value, age);
    row.append(identity, measurement);
    fragment.append(row);
  });
  elements.victronMqttValues.append(fragment);
}

function renderVictronBattery(data) {
  const reading = data?.reading;
  const battery = data?.battery || {};
  const estimation = battery.estimation || null;
  latestVictronVoltage = reading?.batteryVoltageV ?? null;
  renderVictronSocSettings(estimation);
  const rawSoc = battery.socPercent;
  const soc = rawSoc === null || rawSoc === undefined || rawSoc === ""
    ? Number.NaN
    : Number(rawSoc);
  const hasSoc = Number.isFinite(soc) && soc >= 0 && soc <= 100;
  const safeSoc = hasSoc ? Math.max(0, Math.min(100, soc)) : 0;
  const isEstimatedSoc = hasSoc && battery.socSource === "voltage_estimate";

  elements.victronBatteryVisual?.classList.toggle("has-soc", hasSoc);
  elements.victronBatteryVisual?.classList.toggle("is-unavailable", !hasSoc);
  elements.victronBatteryVisual?.classList.toggle("is-estimated", isEstimatedSoc);
  elements.victronBatteryVisual?.classList.toggle("is-charging", battery.flow === "charging");
  elements.victronBatteryVisual?.classList.toggle("is-discharging", battery.flow === "discharging");
  if (hasSoc) {
    elements.victronBatteryVisual?.setAttribute("aria-valuenow", String(Math.round(safeSoc)));
    elements.victronBatteryVisual?.setAttribute(
      "aria-valuetext",
      `${isEstimatedSoc ? "Geschaetzt " : ""}${number(safeSoc, 0)} Prozent`
    );
  } else {
    elements.victronBatteryVisual?.removeAttribute("aria-valuenow");
    elements.victronBatteryVisual?.setAttribute("aria-valuetext", "Nicht verfuegbar");
  }
  if (elements.victronBatteryFill) elements.victronBatteryFill.style.width = `${safeSoc}%`;
  setText(elements.victronBatterySoc, hasSoc ? `${isEstimatedSoc ? "~" : ""}${number(safeSoc, 0)} %` : "-- %");

  const socNotes = {
    mqtt: "Vom Batteriesystem im MQTT-JSON gemeldet.",
    mqtt_topic: "Vom Batteriesystem ueber ein eigenes MQTT-Topic gemeldet.",
    voltage_estimate: estimation
      ? `Aus ${number(reading?.batteryVoltageV, 2)} V geschaetzt: ${estimation.profileLabel}, ${number(estimation.nominalVoltageV, 1)}-V-Profil. Beim Laden nur ungefaehr.`
      : "Spannungsbasierte Schaetzung - kein SmartShunt-SOC.",
    unavailable: estimation?.enabled === false
      ? "Die Spannungs-Schaetzung ist deaktiviert. Ein echter MQTT-SOC wird weiterhin angezeigt."
      : "Der SmartSolar liefert ohne SmartShunt keinen direkten Batterie-SOC.",
  };
  setText(elements.victronBatterySocNote, socNotes[battery.socSource] || socNotes.unavailable);

  const flowLabels = {
    charging: "Wird geladen",
    discharging: "Wird entladen",
    idle: "Kein Stromfluss",
  };
  setText(elements.victronBatteryFlow, reading ? flowLabels[battery.flow] || "Unbekannt" : "Wartet");
  elements.victronBatteryFlow?.classList.toggle("is-charging", battery.flow === "charging");
  elements.victronBatteryFlow?.classList.toggle("is-discharging", battery.flow === "discharging");
  const hasBatteryPower = battery.powerW !== null
    && battery.powerW !== undefined
    && battery.powerW !== ""
    && Number.isFinite(Number(battery.powerW));
  setText(elements.victronBatteryPower, hasBatteryPower ? `${number(battery.powerW, 1)} W` : "-- W");
  setText(
    elements.victronChargeDescription,
    reading
      ? `${number(reading.batteryCurrentA, 2)} A bei ${number(reading.batteryVoltageV, 2)} V`
      : "Noch keine Batteriedaten"
  );

  const stages = ["bulk", "absorption", "float", "storage"];
  const activeIndex = stages.indexOf(reading?.chargerState);
  elements.victronChargeStages?.querySelectorAll("[data-victron-stage]").forEach((stage, index) => {
    stage.classList.toggle("is-active", index === activeIndex);
    stage.classList.toggle("is-complete", activeIndex > index);
  });
}

function renderVictron(data) {
  if (!data) return;
  const reading = data.reading;
  const online = Boolean(data.online);
  elements.victronOnlineBadge.classList.toggle("is-online", online);
  elements.victronOnlineBadge.classList.toggle("status-online", online);
  elements.victronOnlineBadge.classList.toggle("status-offline", !online);
  setText(elements.victronOnlineBadge, online ? "LIVE" : String(data.status || "WARTET").toUpperCase());
  setText(elements.victronTopic, data.configuredTopic || "--");
  setText(elements.victronSourceStatus, victronStatusLabels[data.status] || data.status || "Wartet auf Daten");
  latestVictronHistory = data.history?.points || [];
  renderVictronBattery(data);
  renderVictronMqttTopics(data.mqttTopics);

  if (!reading) {
    drawVictronChart();
    return;
  }

  setText(elements.victronPanelPower, `${number(reading.panelPowerW, 0)} W`);
  setText(elements.victronYieldToday, `${number(reading.yieldTodayWh, 0)} Wh`);
  setText(elements.victronYieldTotal, `${number((data.totalStats?.yieldWh || 0) / 1000, 3)} kWh`);
  setText(elements.victronYieldTotalSince, `Seit ${dateTime(data.totalStats?.startTime)}`);
  setText(elements.victronBatteryVoltage, `${number(reading.batteryVoltageV, 2)} V`);
  setText(elements.victronBatteryCurrent, `${number(reading.batteryCurrentA, 2)} A Batteriestrom`);
  setText(elements.victronChargerState, chargerStateLabels[reading.chargerState] || reading.chargerState || "--");
  setText(elements.victronErrorCode, Number(reading.errorCode) === 0 ? "Kein MPPT-Fehler" : `Fehlercode ${reading.errorCode}`);
  setText(elements.victronPeakToday, `${number(data.todayStats?.peakPanelPowerW, 0)} W`);
  setText(elements.victronAverageToday, `${number(data.todayStats?.averagePanelPowerW, 1)} W`);
  setText(
    elements.victronVoltageRange,
    `${number(data.todayStats?.minimumBatteryVoltageV, 2)} - ${number(data.todayStats?.maximumBatteryVoltageV, 2)} V`
  );
  setText(elements.victronLoadCurrent, `${number(reading.loadCurrentA, 2)} A`);
  setText(elements.victronRssi, `${number(reading.rssi, 0)} dBm`);
  setText(elements.victronLastUpdate, dateTime(reading.receivedAt));
  drawVictronChart();
}

function render(data) {
  const reading = data.reading;
  const online = Boolean(data.online);
  document.body.classList.toggle("energy-offline", !online);
  elements.onlineBadge.classList.toggle("status-online", online);
  elements.onlineBadge.classList.toggle("status-offline", !online);
  setText(elements.onlineBadge, online ? "LIVE" : "OFFLINE");
  setText(elements.topic, data.configuredTopic || "--");
  if (elements.topicInput && document.activeElement !== elements.topicInput) {
    elements.topicInput.value = data.configuredTopic || "";
  }
  setText(elements.priceHint, `${number(data.priceEurKwh, 3)} EUR/kWh`);
  renderVictron(data.victron);

  if (!reading) {
    setText(elements.sourceStatus, "Wartet auf das Tasmota SENSOR Topic");
    latestHistory = data.history?.points || [];
    drawChart();
    return;
  }

  setText(elements.livePower, number(reading.powerW, 0));
  setText(elements.power, number(reading.powerW, 0));
  setText(elements.voltage, number(reading.voltageV, 0));
  setText(elements.current, number(reading.currentA, 3));
  setText(elements.factor, number(reading.powerFactor, 2));
  setText(elements.today, number(reading.todayKwh, 3));
  setText(elements.costToday, currencyFormat.format(data.estimatedCostTodayEur || 0));
  setText(elements.balanceToday, `${number(reading.todayKwh, 3)} kWh`);
  setText(elements.balanceTodayCost, currencyFormat.format(data.estimatedCostTodayEur || 0));
  setText(elements.yesterday, `${number(reading.yesterdayKwh, 3)} kWh`);
  setText(elements.yesterdayCost, currencyFormat.format(data.estimatedCostYesterdayEur || 0));
  setText(elements.total, `${number(reading.totalKwh, 3)} kWh`);
  setText(elements.totalSince, `Seit ${dateTime(reading.totalStartTime)}`);
  setText(elements.peak, `${number(data.todayStats?.peakPowerW, 0)} W`);
  setText(elements.average, `Durchschnitt ${number(data.todayStats?.averagePowerW, 1)} W`);
  setText(elements.apparent, `${number(reading.apparentPowerVa, 0)} VA`);
  setText(elements.reactive, `${number(reading.reactivePowerVar, 0)} var`);
  setText(elements.voltageRange, `${number(data.todayStats?.minimumVoltageV, 0)} - ${number(data.todayStats?.maximumVoltageV, 0)} V`);
  setText(elements.samples, numberFormat.format(data.todayStats?.samples || 0));
  setText(elements.startTime, dateTime(reading.totalStartTime));
  setText(elements.sourceTime, dateTime(reading.sourceTime));
  setText(elements.sourceStatus, online ? "Messdaten werden empfangen" : "Letzte Messung ist veraltet");
  setText(elements.lastUpdate, `Letzte Aktualisierung ${dateTime(reading.receivedAt)}`);

  const dialPercent = Math.min(100, Math.max(2, Number(reading.todayKwh || 0) * 100));
  elements.dial?.style.setProperty("--dial-progress", `${dialPercent * 3.6}deg`);
  latestHistory = data.history?.points || [];
  drawChart();
}

async function refresh() {
  try {
    const query = new URLSearchParams({ period: selectedPeriod, victronPeriod: selectedVictronPeriod });
    const response = await fetch(`/energy/overview?${query}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (response.status === 401 || response.redirected) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Unbekannter Fehler");
    setText(elements.error, "");
    render(data);
  } catch (error) {
    setText(elements.error, `Stromdaten konnten nicht geladen werden: ${error.message}`);
  }
}

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    document.querySelectorAll("[data-period]").forEach((entry) => {
      entry.classList.toggle("is-active", entry === button);
    });
    refresh();
  });
});

document.querySelectorAll("[data-victron-period]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedVictronPeriod = button.dataset.victronPeriod;
    document.querySelectorAll("[data-victron-period]").forEach((entry) => {
      entry.classList.toggle("is-active", entry === button);
    });
    refresh();
  });
});

elements.victronSocSettingsOpen?.addEventListener("click", openVictronSocDialog);
elements.victronSocSettingsClose?.addEventListener("click", closeVictronSocDialog);
elements.victronSocSettingsCancel?.addEventListener("click", closeVictronSocDialog);
elements.victronSocDialog?.addEventListener("click", (event) => {
  if (event.target === elements.victronSocDialog) closeVictronSocDialog();
});

elements.victronSocProfile?.addEventListener("change", updateVictronSocFormPreview);
elements.victronSocSystemVoltage?.addEventListener("change", updateVictronSocFormPreview);
elements.victronSocEnabled?.addEventListener("change", updateVictronSocFormPreview);
elements.victronSocUseCustom?.addEventListener("change", () => {
  if (elements.victronSocUseCustom.checked && !victronSocCustomRangeDirty) {
    const profile = getVictronBatteryProfile(elements.victronSocProfile.value);
    const factor = detectVictronSystemFactor(
      profile,
      elements.victronSocSystemVoltage.value,
      latestVictronVoltage
    );
    elements.victronSocEmptyVoltage.value = (profile.emptyBaseVoltageV * factor).toFixed(2);
    elements.victronSocFullVoltage.value = (profile.fullBaseVoltageV * factor).toFixed(2);
  }
  updateVictronSocFormPreview();
});
elements.victronSocEmptyVoltage?.addEventListener("input", () => {
  victronSocCustomRangeDirty = true;
  updateVictronSocFormPreview();
});
elements.victronSocFullVoltage?.addEventListener("input", () => {
  victronSocCustomRangeDirty = true;
  updateVictronSocFormPreview();
});

elements.victronSocForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  updateVictronSocFormPreview();
  if (!elements.victronSocForm.reportValidity()) return;

  const useCustomRange = elements.victronSocUseCustom.checked
    || elements.victronSocProfile.value === "custom";
  const payload = {
    enabled: elements.victronSocEnabled.checked,
    profile: elements.victronSocProfile.value,
    systemVoltage: elements.victronSocSystemVoltage.value,
    useCustomRange,
    emptyVoltageV: useCustomRange ? readSocVoltageInput(elements.victronSocEmptyVoltage) : null,
    fullVoltageV: useCustomRange ? readSocVoltageInput(elements.victronSocFullVoltage) : null,
  };

  elements.victronSocSettingsSave.disabled = true;
  setText(elements.victronSocSettingsStatus, "Batterieprofil wird gespeichert ...");
  try {
    const response = await fetch("/energy/victron/battery-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    if (response.status === 401 || response.redirected) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error(result.message || result.error || `HTTP ${response.status}`);
    }
    latestVictronEstimation = result.settings;
    populateVictronSocForm(result.settings);
    setText(elements.victronSocSettingsStatus, "Batterieprofil gespeichert.");
    await refresh();
    setTimeout(closeVictronSocDialog, 350);
  } catch (error) {
    setText(elements.victronSocSettingsStatus, `Speichern fehlgeschlagen: ${error.message}`);
  } finally {
    elements.victronSocSettingsSave.disabled = false;
  }
});

elements.customizerTrigger?.addEventListener("click", () => setCustomizerOpen(true));
elements.customizerClose?.addEventListener("click", () => setCustomizerOpen(false));
elements.customizerDone?.addEventListener("click", () => setCustomizerOpen(false));
elements.customizerBackdrop?.addEventListener("click", () => setCustomizerOpen(false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && layoutEditMode) setCustomizerOpen(false);
});

elements.layoutReset?.addEventListener("click", () => {
  energyLayout = defaultEnergyLayout.map((entry) => ({ ...entry }));
  applyEnergyLayout();
  saveEnergyLayout();
});

elements.customizerList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-customizer-action]");
  if (!button) return;
  const item = button.closest("[data-customizer-id]");
  const entry = energyLayout.find((candidate) => candidate.id === item?.dataset.customizerId);
  if (!entry) return;

  const action = button.dataset.customizerAction;
  if (action === "visibility") {
    entry.visible = !entry.visible;
  } else if (action === "width") {
    entry.width = entry.width === "half" ? "full" : "half";
  } else if (action === "collapse") {
    entry.collapsed = !entry.collapsed;
  } else if (action === "up") {
    moveLayoutSection(entry.id, -1);
    return;
  } else if (action === "down") {
    moveLayoutSection(entry.id, 1);
    return;
  }
  applyEnergyLayout();
  saveEnergyLayout();
});

elements.customizerList?.addEventListener("dragstart", (event) => {
  if (!event.target.closest(".energy-customizer-drag")) {
    event.preventDefault();
    return;
  }
  const item = event.target.closest("[data-customizer-id]");
  draggedCustomizerId = item?.dataset.customizerId || null;
  item?.classList.add("is-dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedCustomizerId || "");
  }
});

elements.customizerList?.addEventListener("dragover", (event) => {
  if (!draggedCustomizerId) return;
  const target = event.target.closest("[data-customizer-id]");
  const dragged = elements.customizerList.querySelector(`[data-customizer-id="${draggedCustomizerId}"]`);
  if (!target || !dragged || target === dragged) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  const before = event.clientY < bounds.top + bounds.height / 2;
  elements.customizerList.insertBefore(dragged, before ? target : target.nextSibling);
});

elements.customizerList?.addEventListener("drop", (event) => {
  if (!draggedCustomizerId) return;
  event.preventDefault();
  draggedCustomizerId = null;
  updateLayoutFromCustomizerDom();
});

elements.customizerList?.addEventListener("dragend", () => {
  elements.customizerList.querySelector(".is-dragging")?.classList.remove("is-dragging");
  if (draggedCustomizerId) updateLayoutFromCustomizerDom();
  draggedCustomizerId = null;
});

elements.layoutGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-layout-action]");
  if (!button || button.dataset.layoutAction === "drag") return;
  const section = button.closest("[data-layout-id]");
  const entry = energyLayout.find((item) => item.id === section?.dataset.layoutId);
  if (!entry) return;

  if (button.dataset.layoutAction === "collapse") {
    entry.collapsed = !entry.collapsed;
    applyEnergyLayout();
    saveEnergyLayout();
    return;
  }

});

elements.layoutGrid?.addEventListener("dragstart", (event) => {
  if (!layoutEditMode || !event.target.closest('[data-layout-action="drag"]')) {
    event.preventDefault();
    return;
  }
  const section = event.target.closest("[data-layout-id]");
  draggedLayoutId = section?.dataset.layoutId || null;
  section?.classList.add("is-dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedLayoutId || "");
  }
});

elements.layoutGrid?.addEventListener("dragover", (event) => {
  if (!layoutEditMode || !draggedLayoutId) return;
  const target = event.target.closest("[data-layout-id]");
  const dragged = getLayoutSection(draggedLayoutId);
  if (!target || !dragged || target === dragged || target.classList.contains("energy-layout-hidden-section")) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  const before = event.clientY < bounds.top + bounds.height / 2;
  elements.layoutGrid.insertBefore(dragged, before ? target : target.nextSibling);
});

elements.layoutGrid?.addEventListener("drop", (event) => {
  if (!draggedLayoutId) return;
  event.preventDefault();
  getLayoutSection(draggedLayoutId)?.classList.remove("is-dragging");
  draggedLayoutId = null;
  updateLayoutFromDom();
});

elements.layoutGrid?.addEventListener("dragend", () => {
  getLayoutSection(draggedLayoutId)?.classList.remove("is-dragging");
  if (draggedLayoutId) updateLayoutFromDom();
  draggedLayoutId = null;
});

elements.topicForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sensorTopic = elements.topicInput.value.trim();
  if (!sensorTopic) return;

  elements.topicSave.disabled = true;
  setText(elements.topicStatus, "Topic wird gespeichert ...");
  try {
    const response = await fetch("/energy/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ sensorTopic }),
    });
    if (response.status === 401 || response.redirected) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error === "invalid_sensor_topic" ? "Ungueltiges MQTT-Topic" : result.error);
    }
    elements.topicInput.value = result.configuredTopic;
    setText(elements.topicStatus, "Topic gespeichert. Warte auf neue SENSOR-Daten.");
    await refresh();
  } catch (error) {
    setText(elements.topicStatus, `Topic konnte nicht gespeichert werden: ${error.message}`);
  } finally {
    elements.topicSave.disabled = false;
  }
});

window.addEventListener("resize", () => {
  drawChart();
  drawVictronChart();
});
refresh();
loadEnergyLayout();
setInterval(refresh, 5000);
