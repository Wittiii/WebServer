const db = require('../database/db');
const { topics } = require('../mqttBroker');
const { extractValue } = require('../services/mqttPayloadService');
const {
  listAutomationRules,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  testAutomationRule,
  sanitizeAutomationRule,
  loadAutomationActionsByRuleIds,
  normalizeAutomationWeekdays,
  sanitizeTimeOfDay,
  sanitizeAutomationActions
} = require('./automationController');
const {
  MAX_READINGS_PER_REQUEST,
  listReadings,
  deleteReadings
} = require('./readingsController');
const {
  databaseStatus,
  optimizeDatabaseFile
} = require('./maintenanceController');

function normalizeCommands(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeCommands(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return [];
  return input
    .map((c) => ({
      label: String(c?.label ?? '').trim(),
      payload: String(c?.payload ?? ''),
      topic: String(c?.topic ?? '').trim()
    }))
    .filter((c) => c.label.length > 0);
}

const listObjects = (req, res) => {
  try {
    const rows = db
      .prepare('SELECT id, name, created_at, mqtt_topic, commands, value_key FROM objects ORDER BY id DESC')
      .all();

    const out = rows.map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      mqtt_topic: r.mqtt_topic || '',
      value_key: r.value_key || '',
      commands: normalizeCommands(r.commands)
    }));

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createObject = (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name ist erforderlich' });

  const createdAt = new Date().toISOString();
  const mqttTopic = typeof req.body?.mqttTopic === 'string' ? req.body.mqttTopic.trim() : '';
  const commands = sanitizeCommands(req.body?.commands);
  const commandsJson = JSON.stringify(commands ?? []);
  const valueKey = typeof req.body?.valueKey === 'string' ? req.body.valueKey.trim() : '';

  try {
    const info = db
      .prepare('INSERT INTO objects (name, created_at, mqtt_topic, commands, value_key) VALUES (?, ?, ?, ?, ?)')
      .run(name, createdAt, mqttTopic || null, commandsJson, valueKey || null);

    res.status(201).json({
      id: info.lastInsertRowid,
      name,
      created_at: createdAt,
      mqtt_topic: mqttTopic || '',
      value_key: valueKey || '',
      commands: commands ?? []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateObject = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const updates = [];
  const params = [];

  if (req.body?.valueKey !== undefined) {
    const valueKey = String(req.body.valueKey ?? '').trim();
    updates.push('value_key = ?');
    params.push(valueKey || null);
  }

  if (req.body?.name !== undefined) {
    const name = String(req.body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name ist erforderlich' });
    updates.push('name = ?');
    params.push(name);
  }

  if (req.body?.mqttTopic !== undefined) {
    const mqttTopic = typeof req.body.mqttTopic === 'string' ? req.body.mqttTopic.trim() : '';
    updates.push('mqtt_topic = ?');
    params.push(mqttTopic || null);
  }

  const commands = sanitizeCommands(req.body?.commands);
  if (commands !== undefined) {
    updates.push('commands = ?');
    params.push(JSON.stringify(commands));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Keine Felder zum Update' });
  }

  try {
    const info = db
      .prepare(`UPDATE objects SET ${updates.join(', ')} WHERE id = ?`)
      .run(...params, id);

    res.json({ ok: true, updated: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteObject = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const deleteTransaction = db.transaction((objectId) => {
      db.prepare('DELETE FROM object_readings WHERE object_id = ?').run(objectId);
      db.prepare('DELETE FROM object_value_keys WHERE object_id = ?').run(objectId);
      db.prepare('DELETE FROM object_topic_commands WHERE object_id = ?').run(objectId);
      db.prepare(`
        DELETE FROM object_automation_rule_actions
        WHERE rule_id IN (SELECT id FROM object_automation_rules WHERE object_id = ?)
      `).run(objectId);
      db.prepare('DELETE FROM object_automation_rules WHERE object_id = ?').run(objectId);
      return db.prepare('DELETE FROM objects WHERE id = ?').run(objectId);
    });

    const info = deleteTransaction(id);
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const listValueKeys = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const rows = db
      .prepare(`
        SELECT id, topic, value_key, label, unit, created_at
        FROM object_value_keys
        WHERE object_id = ?
        ORDER BY topic ASC, value_key ASC, id ASC
      `)
      .all(id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createValueKey = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const valueKey = String(req.body?.valueKey ?? '').trim();
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const label = String(req.body?.label ?? '').trim();
  const unit = String(req.body?.unit ?? '').trim();
  if (!valueKey) return res.status(400).json({ error: 'valueKey ist erforderlich' });

  const createdAt = new Date().toISOString();

  try {
    const info = db
      .prepare('INSERT INTO object_value_keys (object_id, topic, value_key, label, unit, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, topic || null, valueKey, label || null, unit || null, createdAt);

    if (topic && topics.has(topic)) {
      try {
        const cached = topics.get(topic);
        const raw = String(cached?.lastMessage ?? '');
        const extracted = extractValue(raw, valueKey);
        if (extracted) {
          const existingReading = db
            .prepare('SELECT 1 FROM object_readings WHERE object_id = ? AND value_key = ? LIMIT 1')
            .get(id, valueKey);
          if (!existingReading) {
            const ts = cached?.timestamp ? new Date(cached.timestamp).toISOString() : createdAt;
            db.prepare(
              'INSERT INTO object_readings (object_id, topic, value_key, value_text, raw_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(id, topic, valueKey, extracted, raw, ts);
          }
        }
      } catch {}
    }

    res.status(201).json({
      id: info.lastInsertRowid,
      topic: topic || '',
      value_key: valueKey,
      label: label || '',
      unit: unit || '',
      created_at: createdAt
    });
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'valueKey existiert bereits fuer dieses Objekt' });
    }
    res.status(500).json({ error: err.message });
  }
};

const updateValueKey = (req, res) => {
  const objectId = Number(req.params.id);
  const keyId = Number(req.params.keyId);
  if (!Number.isFinite(objectId) || !Number.isFinite(keyId)) {
    return res.status(400).json({ error: 'Ungueltige ID' });
  }

  const valueKey = String(req.body?.valueKey ?? '').trim();
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const label = String(req.body?.label ?? '').trim();
  const unit = String(req.body?.unit ?? '').trim();
  if (!valueKey) return res.status(400).json({ error: 'valueKey ist erforderlich' });

  try {
    const info = db
      .prepare(`
        UPDATE object_value_keys
        SET topic = ?, value_key = ?, label = ?, unit = ?
        WHERE id = ? AND object_id = ?
      `)
      .run(topic || null, valueKey, label || null, unit || null, keyId, objectId);

    res.json({ ok: true, updated: info.changes });
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'valueKey existiert bereits' });
    }
    res.status(500).json({ error: err.message });
  }
};

const deleteValueKey = (req, res) => {
  const objectId = Number(req.params.id);
  const keyId = Number(req.params.keyId);
  if (!Number.isFinite(objectId) || !Number.isFinite(keyId)) {
    return res.status(400).json({ error: 'Ungueltige ID' });
  }

  try {
    const info = db
      .prepare('DELETE FROM object_value_keys WHERE id = ? AND object_id = ?')
      .run(keyId, objectId);
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const listTopicCommands = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const obj = db.prepare('SELECT id, commands FROM objects WHERE id = ?').get(id);
    if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

    const row = db
      .prepare('SELECT commands FROM object_topic_commands WHERE object_id = ? AND (topic = ? OR topic IS NULL) LIMIT 1')
      .get(id, '');

    const cmds = row ? normalizeCommands(row.commands) : normalizeCommands(obj.commands);
    res.json({ topic: '', commands: cmds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateTopicCommands = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const commands = sanitizeCommands(req.body?.commands) ?? [];

  try {
    const obj = db.prepare('SELECT id FROM objects WHERE id = ?').get(id);
    if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

    const topic = '';
    const now = new Date().toISOString();
    const commandsJson = JSON.stringify(commands);

    db.prepare(`
      INSERT INTO object_topic_commands (object_id, topic, commands, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(object_id, topic)
      DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at
    `).run(id, topic, commandsJson, now, now);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const listTopics = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const obj = db.prepare('SELECT mqtt_topic FROM objects WHERE id = ?').get(id);
    if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

    const rows = db
      .prepare('SELECT topic FROM object_topic_commands WHERE object_id = ? ORDER BY topic ASC')
      .all(id);

    const set = new Set(rows.map((r) => r.topic));
    if (obj.mqtt_topic) set.add(obj.mqtt_topic);

    res.json({ topics: Array.from(set) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  // Objects & Keys & Commands
  listObjects,
  createObject,
  updateObject,
  deleteObject,
  listValueKeys,
  createValueKey,
  deleteValueKey,
  updateValueKey,
  listTopicCommands,
  updateTopicCommands,
  listTopics,
  // Delegated: Readings
  MAX_READINGS_PER_REQUEST,
  listReadings,
  deleteReadings,
  // Delegated: Automations
  listAutomationRules,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  testAutomationRule,
  sanitizeAutomationRule,
  loadAutomationActionsByRuleIds,
  normalizeAutomationWeekdays,
  sanitizeTimeOfDay,
  sanitizeAutomationActions,
  // Delegated: Maintenance
  databaseStatus,
  optimizeDatabaseFile
};
