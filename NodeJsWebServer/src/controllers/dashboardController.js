const path = require('path');
const db = require('../database/db');

const getDashboard = (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public','pages','dashboard','dashboard.html');
  res.sendFile(filePath);
};

function sanitizeWidgets(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((widget) => {
      const base = {
        id: String(widget?.id ?? '').trim(),
        type: widget?.type === 'command' ? 'command' : 'value',
        objectId: Number(widget?.objectId),
        objectName: String(widget?.objectName ?? '').trim(),
        title: String(widget?.title ?? '').trim(),
      };

      if (!base.id || !Number.isFinite(base.objectId)) return null;

      if (base.type === 'command') {
        return {
          ...base,
          commandLabel: String(widget?.commandLabel ?? '').trim(),
          commandTopic: String(widget?.commandTopic ?? '').trim(),
          commandPayload: String(widget?.commandPayload ?? ''),
        };
      }

      return {
        ...base,
        keyName: String(widget?.keyName ?? '').trim(),
        keyLabel: String(widget?.keyLabel ?? '').trim(),
        unit: String(widget?.unit ?? '').trim(),
      };
    })
    .filter(Boolean);
}

const getDashboardWidgets = (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'Nicht eingeloggt' });

  try {
    const row = db
      .prepare('SELECT widgets FROM user_dashboard_widgets WHERE username = ?')
      .get(username);

    let widgets = [];
    if (row?.widgets) {
      try {
        const parsed = JSON.parse(row.widgets);
        widgets = Array.isArray(parsed) ? parsed : [];
      } catch {
        widgets = [];
      }
    }

    res.json({ widgets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const saveDashboardWidgets = (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'Nicht eingeloggt' });

  const widgets = sanitizeWidgets(req.body?.widgets);
  const updatedAt = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO user_dashboard_widgets (username, widgets, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        widgets = excluded.widgets,
        updated_at = excluded.updated_at
    `).run(username, JSON.stringify(widgets), updatedAt);

    res.json({ ok: true, widgets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getDashboard, getDashboardWidgets, saveDashboardWidgets };
