const db = require("../database/db");

const DEFAULT_LAYOUT = [
  { id: "live-values", width: "full", visible: true, collapsed: false },
  { id: "energy-balance", width: "full", visible: true, collapsed: false },
  { id: "consumption-chart", width: "full", visible: true, collapsed: false },
  { id: "victron", width: "full", visible: true, collapsed: false },
  { id: "meter-details", width: "full", visible: true, collapsed: false },
];

const allowedIds = new Set(DEFAULT_LAYOUT.map((entry) => entry.id));

function cloneDefaultLayout() {
  return DEFAULT_LAYOUT.map((entry) => ({ ...entry }));
}

function sanitizeEnergyLayout(input) {
  if (!Array.isArray(input)) return cloneDefaultLayout();

  const seen = new Set();
  const layout = [];
  for (const entry of input) {
    const id = String(entry?.id || "").trim();
    if (!allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    layout.push({
      id,
      width: entry?.width === "half" ? "half" : "full",
      visible: entry?.visible !== false,
      collapsed: entry?.collapsed === true,
    });
  }

  for (const entry of DEFAULT_LAYOUT) {
    if (!seen.has(entry.id)) layout.push({ ...entry });
  }
  return layout;
}

function getEnergyLayout(username) {
  const row = db
    .prepare("SELECT layout FROM user_energy_layouts WHERE username = ?")
    .get(username);
  if (!row?.layout) return cloneDefaultLayout();

  try {
    return sanitizeEnergyLayout(JSON.parse(row.layout));
  } catch {
    return cloneDefaultLayout();
  }
}

function saveEnergyLayout(username, input) {
  const layout = sanitizeEnergyLayout(input);
  db.prepare(`
    INSERT INTO user_energy_layouts (username, layout, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      layout = excluded.layout,
      updated_at = excluded.updated_at
  `).run(username, JSON.stringify(layout), new Date().toISOString());
  return layout;
}

module.exports = {
  DEFAULT_LAYOUT,
  getEnergyLayout,
  sanitizeEnergyLayout,
  saveEnergyLayout,
};
