const db = require("../database/db");

const BATTERY_PROFILES = Object.freeze({
  lifepo4: Object.freeze({
    id: "lifepo4",
    label: "LiFePO4",
    description: "Lithium-Eisenphosphat, 4S / 8S / 12S / 16S",
    nominalBaseVoltageV: 12.8,
    // Victron LFP reference values: end-of-discharge and full float voltage.
    emptyBaseVoltageV: 11.2,
    fullBaseVoltageV: 13.5,
  }),
  agm: Object.freeze({
    id: "agm",
    label: "AGM / Blei",
    description: "Geschlossene 12-V-Bleibatterie",
    nominalBaseVoltageV: 12,
    emptyBaseVoltageV: 11.8,
    fullBaseVoltageV: 12.8,
  }),
  gel: Object.freeze({
    id: "gel",
    label: "Gel",
    description: "12-V-Gelbatterie",
    nominalBaseVoltageV: 12,
    emptyBaseVoltageV: 11.8,
    fullBaseVoltageV: 12.85,
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Frei konfiguriert",
    description: "Eigene absolute Leer- und Vollspannung",
    nominalBaseVoltageV: 12,
    emptyBaseVoltageV: 11,
    fullBaseVoltageV: 14,
  }),
});

const SYSTEM_VOLTAGES = new Set(["auto", "12", "24", "36", "48"]);
const SYSTEM_FACTORS = Object.freeze({ 12: 1, 24: 2, 36: 3, 48: 4 });

function finite(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const legacyEmptyVoltage = finite(process.env.VICTRON_BATTERY_SOC_EMPTY_V);
const legacyFullVoltage = finite(process.env.VICTRON_BATTERY_SOC_FULL_V);
const hasLegacyRange = legacyEmptyVoltage !== null
  && legacyFullVoltage !== null
  && legacyFullVoltage > legacyEmptyVoltage;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  profile: "lifepo4",
  systemVoltage: "auto",
  useCustomRange: hasLegacyRange,
  emptyVoltageV: hasLegacyRange ? legacyEmptyVoltage : null,
  fullVoltageV: hasLegacyRange ? legacyFullVoltage : null,
});

const selectSettings = db.prepare(`
  SELECT estimation_enabled, profile, system_voltage, use_custom_range,
         empty_voltage_v, full_voltage_v
  FROM victron_battery_settings
  WHERE id = 1
`);

const upsertSettings = db.prepare(`
  INSERT INTO victron_battery_settings (
    id, estimation_enabled, profile, system_voltage, use_custom_range,
    empty_voltage_v, full_voltage_v, updated_at
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    estimation_enabled = excluded.estimation_enabled,
    profile = excluded.profile,
    system_voltage = excluded.system_voltage,
    use_custom_range = excluded.use_custom_range,
    empty_voltage_v = excluded.empty_voltage_v,
    full_voltage_v = excluded.full_voltage_v,
    updated_at = excluded.updated_at
`);

function cloneDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

function rowToSettings(row) {
  if (!row) return cloneDefaultSettings();
  const profile = BATTERY_PROFILES[row.profile] ? row.profile : DEFAULT_SETTINGS.profile;
  const systemVoltage = SYSTEM_VOLTAGES.has(String(row.system_voltage))
    ? String(row.system_voltage)
    : DEFAULT_SETTINGS.systemVoltage;
  const emptyVoltageV = finite(row.empty_voltage_v);
  const fullVoltageV = finite(row.full_voltage_v);
  const hasValidCustomRange = emptyVoltageV !== null
    && fullVoltageV !== null
    && fullVoltageV > emptyVoltageV;

  return {
    enabled: row.estimation_enabled !== 0,
    profile,
    systemVoltage,
    useCustomRange: (row.use_custom_range === 1 || profile === "custom") && hasValidCustomRange,
    emptyVoltageV: hasValidCustomRange ? emptyVoltageV : null,
    fullVoltageV: hasValidCustomRange ? fullVoltageV : null,
  };
}

function getBatterySettings() {
  return rowToSettings(selectSettings.get());
}

function invalidSettings(message) {
  const error = new Error(message);
  error.code = "invalid_victron_battery_settings";
  return error;
}

function sanitizeBatterySettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidSettings("Einstellungen fehlen");
  }

  const profile = String(input.profile || "").trim().toLowerCase();
  if (!BATTERY_PROFILES[profile]) throw invalidSettings("Unbekanntes Batterieprofil");

  const systemVoltage = String(input.systemVoltage || "").trim().toLowerCase();
  if (!SYSTEM_VOLTAGES.has(systemVoltage)) throw invalidSettings("Ungueltige Systemspannung");

  const useCustomRange = input.useCustomRange === true || profile === "custom";
  const emptyVoltageV = finite(input.emptyVoltageV);
  const fullVoltageV = finite(input.fullVoltageV);
  if (useCustomRange) {
    if (emptyVoltageV === null || fullVoltageV === null) {
      throw invalidSettings("Leer- und Vollspannung werden benoetigt");
    }
    if (emptyVoltageV < 1 || fullVoltageV > 100 || fullVoltageV - emptyVoltageV < 0.2) {
      throw invalidSettings("Der Spannungsbereich ist unplausibel");
    }
  }

  return {
    enabled: input.enabled !== false,
    profile,
    systemVoltage,
    useCustomRange,
    emptyVoltageV: useCustomRange ? emptyVoltageV : null,
    fullVoltageV: useCustomRange ? fullVoltageV : null,
  };
}

function saveBatterySettings(input) {
  const settings = sanitizeBatterySettings(input);
  upsertSettings.run(
    settings.enabled ? 1 : 0,
    settings.profile,
    settings.systemVoltage,
    settings.useCustomRange ? 1 : 0,
    settings.emptyVoltageV,
    settings.fullVoltageV,
    new Date().toISOString()
  );
  return settings;
}

function detectSystemFactor(batteryVoltageV, profile, systemVoltage) {
  if (systemVoltage !== "auto") return SYSTEM_FACTORS[systemVoltage] || 1;
  const voltage = finite(batteryVoltageV);
  if (voltage === null || voltage <= 0) return 1;

  return [1, 2, 3, 4].reduce((best, factor) => {
    const bestDistance = Math.abs(voltage - profile.nominalBaseVoltageV * best);
    const distance = Math.abs(voltage - profile.nominalBaseVoltageV * factor);
    return distance < bestDistance ? factor : best;
  }, 1);
}

function scaleVoltage(value, factor) {
  return Math.round(value * factor * 1000) / 1000;
}

function getBatteryEstimation(batteryVoltageV, settings = getBatterySettings()) {
  const profile = BATTERY_PROFILES[settings.profile] || BATTERY_PROFILES.lifepo4;
  const factor = detectSystemFactor(batteryVoltageV, profile, settings.systemVoltage);
  const emptyVoltageV = settings.useCustomRange
    ? settings.emptyVoltageV
    : scaleVoltage(profile.emptyBaseVoltageV, factor);
  const fullVoltageV = settings.useCustomRange
    ? settings.fullVoltageV
    : scaleVoltage(profile.fullBaseVoltageV, factor);
  const voltage = finite(batteryVoltageV);
  const canEstimate = settings.enabled
    && voltage !== null
    && Number.isFinite(emptyVoltageV)
    && Number.isFinite(fullVoltageV)
    && fullVoltageV > emptyVoltageV;
  const socPercent = canEstimate
    ? Math.max(0, Math.min(100, ((voltage - emptyVoltageV) / (fullVoltageV - emptyVoltageV)) * 100))
    : null;

  return {
    enabled: settings.enabled,
    profile: profile.id,
    profileLabel: profile.label,
    profileDescription: profile.description,
    systemVoltage: settings.systemVoltage,
    detectedSystemVoltage: factor * 12,
    nominalVoltageV: scaleVoltage(profile.nominalBaseVoltageV, factor),
    useCustomRange: settings.useCustomRange,
    emptyVoltageV,
    fullVoltageV,
    socPercent,
    availableProfiles: Object.values(BATTERY_PROFILES).map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      nominalBaseVoltageV: entry.nominalBaseVoltageV,
      emptyBaseVoltageV: entry.emptyBaseVoltageV,
      fullBaseVoltageV: entry.fullBaseVoltageV,
    })),
  };
}

module.exports = {
  BATTERY_PROFILES,
  DEFAULT_SETTINGS,
  getBatteryEstimation,
  getBatterySettings,
  sanitizeBatterySettings,
  saveBatterySettings,
};
