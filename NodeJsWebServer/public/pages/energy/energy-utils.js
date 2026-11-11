export const fallbackVictronBatteryProfiles = [
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

export const chargerStateLabels = {
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

export const victronStatusLabels = {
  ready: "BLE-Daten werden empfangen",
  waiting: "Wartet auf Victron BLE-Daten",
  stale: "Victron BLE-Daten sind veraltet",
  not_configured: "Victron ist im DFR1154 nicht konfiguriert",
  init_error: "Victron BLE konnte nicht gestartet werden",
  disabled: "Victron BLE ist deaktiviert",
};

export const victronMqttLabels = {
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

export function number(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return numeric.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function dateTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("de-DE");
}

export function setText(element, value) {
  if (element) element.textContent = value;
}

export function formatAxisTime(timestamp, period) {
  const date = new Date(timestamp);
  if (period === "1h" || period === "24h") {
    return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

export function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

export function formatTopicAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "Zeit unbekannt";
  if (value < 2) return "gerade eben";
  if (value < 60) return `vor ${value} s`;
  if (value < 3600) return `vor ${Math.floor(value / 60)} min`;
  if (value < 86400) return `vor ${Math.floor(value / 3600)} h`;
  return `vor ${Math.floor(value / 86400)} d`;
}

export function getVictronBatteryProfile(profiles, profileId) {
  const list = Array.isArray(profiles) && profiles.length ? profiles : fallbackVictronBatteryProfiles;
  return list.find((profile) => profile.id === profileId)
    || fallbackVictronBatteryProfiles.find((profile) => profile.id === profileId)
    || fallbackVictronBatteryProfiles[0];
}

export function detectVictronSystemFactor(profile, selectedSystem, batteryVoltageV, latestDetected) {
  if (selectedSystem !== "auto") return { 12: 1, 24: 2, 36: 3, 48: 4 }[selectedSystem] || 1;
  const voltage = Number(batteryVoltageV);
  if (!Number.isFinite(voltage) || voltage <= 0) {
    const detected = Number(latestDetected);
    return { 12: 1, 24: 2, 36: 3, 48: 4 }[detected] || 1;
  }
  return [1, 2, 3, 4].reduce((best, factor) => {
    const bestDistance = Math.abs(voltage - profile.nominalBaseVoltageV * best);
    const distance = Math.abs(voltage - profile.nominalBaseVoltageV * factor);
    return distance < bestDistance ? factor : best;
  }, 1);
}
