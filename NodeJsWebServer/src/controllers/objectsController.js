const db = require('../database/db');

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
      payload: String(c?.payload ?? '')
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

const listReadings = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const key = typeof req.query?.key === 'string' ? req.query.key.trim() : '';
  const from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
  const to = typeof req.query?.to === 'string' ? req.query.to.trim() : '';
  const limitParam = String(req.query?.limit ?? '').trim();
  const limitRaw = Number(limitParam);
  const noLimit = limitParam === '0' || limitParam.toLowerCase() === 'all';
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 5000) : 100;

  try {
    const params = [id];
    let sql = `
      SELECT id, topic, value_key, value_text, raw_payload, created_at
      FROM object_readings
      WHERE object_id = ?
    `;

    if (key) {
      sql += ' AND value_key = ?';
      params.push(key);
    }
    if (from) {
      sql += ' AND created_at >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at <= ?';
      params.push(to);
    }

    sql += ' ORDER BY id DESC';
    if (!noLimit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params);

    res.json(rows);
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
        SELECT id, value_key, label, unit, created_at
        FROM object_value_keys
        WHERE object_id = ?
        ORDER BY id ASC
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
  const label = String(req.body?.label ?? '').trim();
  const unit = String(req.body?.unit ?? '').trim();
  if (!valueKey) return res.status(400).json({ error: 'valueKey ist erforderlich' });

  const createdAt = new Date().toISOString();

  try {
    const info = db
      .prepare('INSERT INTO object_value_keys (object_id, value_key, label, unit, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, valueKey, label || null, unit || null, createdAt);

    res.status(201).json({
      id: info.lastInsertRowid,
      value_key: valueKey,
      label: label || '',
      unit: unit || '',
      created_at: createdAt
    });
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

const updateValueKey = (req, res) => {
  const objectId = Number(req.params.id);
  const keyId = Number(req.params.keyId);
  if (!Number.isFinite(objectId) || !Number.isFinite(keyId)) {
    return res.status(400).json({ error: 'Ungueltige ID' });
  }

  const valueKey = String(req.body?.valueKey ?? '').trim();
  const label = String(req.body?.label ?? '').trim();
  const unit = String(req.body?.unit ?? '').trim();
  if (!valueKey) return res.status(400).json({ error: 'valueKey ist erforderlich' });

  try {
    const info = db
      .prepare(`
        UPDATE object_value_keys
        SET value_key = ?, label = ?, unit = ?
        WHERE id = ? AND object_id = ?
      `)
      .run(valueKey, label || null, unit || null, keyId, objectId);

    res.json({ ok: true, updated: info.changes });
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'valueKey existiert bereits' });
    }
    res.status(500).json({ error: err.message });
  }
};

const deleteObject = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const info = db.prepare('DELETE FROM objects WHERE id = ?').run(id);
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const listTopicCommands = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const topicParam = typeof req.query?.topic === 'string' ? req.query.topic.trim() : '';

  try {
    const obj = db.prepare('SELECT id, mqtt_topic, commands FROM objects WHERE id = ?').get(id);
    if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

    const topic = topicParam || obj.mqtt_topic || '';
    if (!topic) {
      return res.json({ topic: '', commands: normalizeCommands(obj.commands) });
    }

    const row = db
      .prepare('SELECT commands FROM object_topic_commands WHERE object_id = ? AND topic = ?')
      .get(id, topic);

    const cmds = row ? normalizeCommands(row.commands) : normalizeCommands(obj.commands);
    res.json({ topic, commands: cmds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateTopicCommands = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const topicParam = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const commands = sanitizeCommands(req.body?.commands) ?? [];

  try {
    const obj = db.prepare('SELECT id, mqtt_topic FROM objects WHERE id = ?').get(id);
    if (!obj) return res.status(404).json({ error: 'Objekt nicht gefunden' });

    const topic = topicParam || obj.mqtt_topic || '';
    if (!topic) return res.status(400).json({ error: 'topic ist erforderlich' });

    const now = new Date().toISOString();
    const commandsJson = JSON.stringify(commands);

    db.prepare(`
      INSERT INTO object_topic_commands (object_id, topic, commands, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(object_id, topic)
      DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at
    `).run(id, topic, commandsJson, now, now);

    if (obj.mqtt_topic === topic) {
      db.prepare('UPDATE objects SET commands = ? WHERE id = ?').run(commandsJson, id);
    }

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
  listObjects,
  createObject,
  updateObject,
  deleteObject,
  listReadings,
  listValueKeys,
  createValueKey,
  deleteValueKey,
  updateValueKey,
  listTopicCommands,
  updateTopicCommands,
  listTopics
};
