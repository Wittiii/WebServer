const db = require('../database/db');

const { publishAutomationActions } = require('../services/automationService');
const {
  getDatabaseStats,
  optimizeDatabase
} = require('../services/databaseMaintenanceService');

const MAX_READINGS_PER_REQUEST = 5000;

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

function parseNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function parseNonNegativeNumber(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeAutomationWeekdays(value) {
  if (value == null || value === '') return [];

  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) return [];

  return Array.from(new Set(
    source
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6)
  )).sort((a, b) => a - b);
}

function sanitizeTimeOfDay(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d{2}:\d{2}$/.test(text)) return null;
  const [hours, minutes] = text.split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return text;
}

function sanitizeAutomationActions(input, fallbackInput) {
  let source = [];
  if (Array.isArray(input)) {
    source = input;
  } else if (fallbackInput) {
    source = [{
      actionType: fallbackInput.actionType,
      actionLabel: fallbackInput.actionLabel,
      actionTopic: fallbackInput.actionTopic,
      actionPayload: fallbackInput.actionPayload,
    }];
  }

  return source
    .map((action, index) => ({
      position: index,
      actionType: action?.actionType === 'command' ? 'command' : 'custom',
      actionLabel: String(action?.actionLabel ?? '').trim(),
      actionTopic: String(action?.actionTopic ?? '').trim(),
      actionPayload: String(action?.actionPayload ?? ''),
    }))
    .filter((action) => action.actionTopic);
}

function sanitizeAutomationRule(input) {
  const triggerType = input?.triggerType === 'time' ? 'time' : 'value';
  const enabled = input?.enabled === false ? 0 : 1;
  const name = String(input?.name ?? '').trim();
  const valueKey = String(input?.valueKey ?? '').trim();
  const operator = String(input?.operator ?? '').trim();
  const compareValue = String(input?.compareValue ?? '').trim();
  const scheduleTime = String(input?.scheduleTime ?? '').trim();
  const weekdays = normalizeAutomationWeekdays(input?.weekdays);
  const windowStart = sanitizeTimeOfDay(input?.windowStart);
  const windowEnd = sanitizeTimeOfDay(input?.windowEnd);
  const cooldownSeconds = parseNonNegativeInteger(input?.cooldownSeconds);
  const hysteresisValue = triggerType === 'value' ? parseNonNegativeNumber(input?.hysteresisValue) : null;
  const actions = sanitizeAutomationActions(input?.actions, input);

  if (!name) {
    return { error: 'name ist erforderlich' };
  }
  if (!actions.length) {
    return { error: 'Mindestens eine Aktion ist erforderlich' };
  }

  if (triggerType === 'value') {
    if (!valueKey) return { error: 'valueKey ist erforderlich' };
    if (!['>', '>=', '<', '<=', '=', '!='].includes(operator)) {
      return { error: 'operator ist ungueltig' };
    }
    if (!compareValue) return { error: 'compareValue ist erforderlich' };
  }

  if (triggerType === 'time') {
    if (!scheduleTime || sanitizeTimeOfDay(scheduleTime) === null) {
      return { error: 'scheduleTime ist ungueltig' };
    }
  }

  if (windowStart === null || windowEnd === null) {
    return { error: 'Zeitfenster ist ungueltig' };
  }
  if ((windowStart && !windowEnd) || (!windowStart && windowEnd)) {
    return { error: 'Bitte Start und Ende fuer das Zeitfenster angeben' };
  }

  return {
    name,
    enabled,
    triggerType,
    valueKey: triggerType === 'value' ? valueKey : '',
    operator: triggerType === 'value' ? operator : '',
    compareValue: triggerType === 'value' ? compareValue : '',
    scheduleTime: triggerType === 'time' ? scheduleTime : '',
    weekdays,
    windowStart,
    windowEnd,
    cooldownSeconds,
    hysteresisValue,
    actions,
  };
}

function loadAutomationActionsByRuleIds(ruleIds) {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) return new Map();

  const placeholders = ruleIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT rule_id, position, action_type, action_label, action_topic, action_payload
    FROM object_automation_rule_actions
    WHERE rule_id IN (${placeholders})
    ORDER BY rule_id ASC, position ASC, id ASC
  `).all(...ruleIds);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.rule_id)) map.set(row.rule_id, []);
    map.get(row.rule_id).push({
      actionType: row.action_type,
      actionLabel: row.action_label || '',
      actionTopic: row.action_topic || '',
      actionPayload: row.action_payload || '',
    });
  }
  return map;
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
  const topic = typeof req.query?.topic === 'string' ? req.query.topic.trim() : '';
  const from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
  const to = typeof req.query?.to === 'string' ? req.query.to.trim() : '';
  const limitParam = String(req.query?.limit ?? '').trim();
  const limitRaw = Number(limitParam);
  const requestedAll = limitParam === '0' || limitParam.toLowerCase() === 'all';
  const limit = requestedAll
    ? MAX_READINGS_PER_REQUEST
    : limitParam && Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_READINGS_PER_REQUEST)
      : 100;

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
    if (topic) {
      sql += ' AND topic = ?';
      params.push(topic);
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
    sql += ' LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteReadings = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const info = db.prepare('DELETE FROM object_readings WHERE object_id = ?').run(id);
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const databaseStatus = (req, res) => {
  try {
    res.json({ ok: true, ...getDatabaseStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const optimizeDatabaseFile = (req, res) => {
  try {
    res.json({ ok: true, ...optimizeDatabase() });
  } catch (err) {
    if (err.code === 'DATABASE_OPTIMIZATION_RUNNING') {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === 'DATABASE_OPTIMIZATION_INSUFFICIENT_SPACE') {
      return res.status(507).json({
        error: err.message,
        requiredFreeBytes: err.requiredFreeBytes,
        availableDiskBytes: err.availableDiskBytes
      });
    }
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

const listAutomationRules = (req, res) => {
  const objectId = Number(req.params.id);
  if (!Number.isFinite(objectId)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const rows = db.prepare(`
      SELECT id, name, enabled, trigger_type, value_key, operator, compare_value,
             schedule_time, weekdays_json, window_start, window_end,
             cooldown_seconds, hysteresis_value,
             action_type, action_label, action_topic, action_payload,
             last_fired_at, created_at, updated_at
      FROM object_automation_rules
      WHERE object_id = ?
      ORDER BY id DESC
    `).all(objectId);

    const actionsByRule = loadAutomationActionsByRuleIds(rows.map((row) => row.id));

    res.json(rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      triggerType: row.trigger_type,
      valueKey: row.value_key || '',
      operator: row.operator || '',
      compareValue: row.compare_value || '',
      scheduleTime: row.schedule_time || '',
      weekdays: normalizeAutomationWeekdays(row.weekdays_json),
      windowStart: row.window_start || '',
      windowEnd: row.window_end || '',
      cooldownSeconds: Number(row.cooldown_seconds || 0),
      hysteresisValue: row.hysteresis_value == null ? '' : row.hysteresis_value,
      actions: actionsByRule.get(row.id) || [{
        actionType: row.action_type || 'custom',
        actionLabel: row.action_label || '',
        actionTopic: row.action_topic || '',
        actionPayload: row.action_payload || '',
      }].filter((action) => action.actionTopic),
      lastFiredAt: row.last_fired_at || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const createAutomationRule = (req, res) => {
  const objectId = Number(req.params.id);
  if (!Number.isFinite(objectId)) return res.status(400).json({ error: 'Ungueltige ID' });

  const rule = sanitizeAutomationRule(req.body);
  if (rule.error) return res.status(400).json({ error: rule.error });

  const now = new Date().toISOString();

  try {
    const transaction = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO object_automation_rules (
          object_id, name, enabled, trigger_type, value_key, operator, compare_value,
          schedule_time, weekdays_json, window_start, window_end, cooldown_seconds, hysteresis_value,
          action_type, action_label, action_topic, action_payload,
          last_fired_at, last_condition_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
      `).run(
        objectId,
        rule.name,
        rule.enabled,
        rule.triggerType,
        rule.valueKey || null,
        rule.operator || null,
        rule.compareValue || null,
        rule.scheduleTime || null,
        rule.weekdays.length ? JSON.stringify(rule.weekdays) : null,
        rule.windowStart || null,
        rule.windowEnd || null,
        rule.cooldownSeconds,
        rule.hysteresisValue,
        rule.actions[0]?.actionType || 'custom',
        rule.actions[0]?.actionLabel || null,
        rule.actions[0]?.actionTopic || '',
        rule.actions[0]?.actionPayload || '',
        now,
        now
      );

      const actionStmt = db.prepare(`
        INSERT INTO object_automation_rule_actions (
          rule_id, position, action_type, action_label, action_topic, action_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      rule.actions.forEach((action, index) => {
        actionStmt.run(
          info.lastInsertRowid,
          index,
          action.actionType,
          action.actionLabel || null,
          action.actionTopic,
          action.actionPayload,
          now,
          now
        );
      });

      return info.lastInsertRowid;
    });

    const createdId = transaction();

    res.status(201).json({ ok: true, id: createdId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateAutomationRule = (req, res) => {
  const objectId = Number(req.params.id);
  const ruleId = Number(req.params.ruleId);
  if (!Number.isFinite(objectId) || !Number.isFinite(ruleId)) {
    return res.status(400).json({ error: 'Ungueltige ID' });
  }

  const rule = sanitizeAutomationRule(req.body);
  if (rule.error) return res.status(400).json({ error: rule.error });

  const now = new Date().toISOString();

  try {
    const transaction = db.transaction(() => {
      const info = db.prepare(`
        UPDATE object_automation_rules
        SET name = ?, enabled = ?, trigger_type = ?, value_key = ?, operator = ?,
            compare_value = ?, schedule_time = ?, weekdays_json = ?, window_start = ?, window_end = ?,
            cooldown_seconds = ?, hysteresis_value = ?,
            action_type = ?, action_label = ?, action_topic = ?, action_payload = ?,
            updated_at = ?, last_condition_state = 0
        WHERE id = ? AND object_id = ?
      `).run(
        rule.name,
        rule.enabled,
        rule.triggerType,
        rule.valueKey || null,
        rule.operator || null,
        rule.compareValue || null,
        rule.scheduleTime || null,
        rule.weekdays.length ? JSON.stringify(rule.weekdays) : null,
        rule.windowStart || null,
        rule.windowEnd || null,
        rule.cooldownSeconds,
        rule.hysteresisValue,
        rule.actions[0]?.actionType || 'custom',
        rule.actions[0]?.actionLabel || null,
        rule.actions[0]?.actionTopic || '',
        rule.actions[0]?.actionPayload || '',
        now,
        ruleId,
        objectId
      );

      if (info.changes === 0) return 0;
      db.prepare('DELETE FROM object_automation_rule_actions WHERE rule_id = ?').run(ruleId);
      const actionStmt = db.prepare(`
        INSERT INTO object_automation_rule_actions (
          rule_id, position, action_type, action_label, action_topic, action_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      rule.actions.forEach((action, index) => {
        actionStmt.run(
          ruleId,
          index,
          action.actionType,
          action.actionLabel || null,
          action.actionTopic,
          action.actionPayload,
          now,
          now
        );
      });

      return info.changes;
    });

    const updated = transaction();

    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteAutomationRule = (req, res) => {
  const objectId = Number(req.params.id);
  const ruleId = Number(req.params.ruleId);
  if (!Number.isFinite(objectId) || !Number.isFinite(ruleId)) {
    return res.status(400).json({ error: 'Ungueltige ID' });
  }

  try {
    const transaction = db.transaction(() => {
      const rule = db.prepare('SELECT id FROM object_automation_rules WHERE id = ? AND object_id = ?')
        .get(ruleId, objectId);
      if (!rule) return { changes: 0 };
      db.prepare('DELETE FROM object_automation_rule_actions WHERE rule_id = ?').run(ruleId);
      return db
        .prepare('DELETE FROM object_automation_rules WHERE id = ? AND object_id = ?')
        .run(ruleId, objectId);
    });
    const info = transaction();
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const testAutomationRule = async (req, res) => {
  const objectId = Number(req.params.id);
  const ruleId = Number(req.params.ruleId);
  if (!Number.isFinite(objectId) || !Number.isFinite(ruleId)) {
    return res.status(400).json({ error: 'Ungueltige ID' });
  }

  try {
    const row = db.prepare(`
      SELECT id, action_type, action_label, action_topic, action_payload
      FROM object_automation_rules
      WHERE id = ? AND object_id = ?
      LIMIT 1
    `).get(ruleId, objectId);

    if (!row) {
      return res.status(404).json({ error: 'Regel nicht gefunden' });
    }

    const actions = loadAutomationActionsByRuleIds([ruleId]).get(ruleId) || [{
      actionType: row.action_type || 'custom',
      actionLabel: row.action_label || '',
      actionTopic: row.action_topic || '',
      actionPayload: row.action_payload || '',
    }].filter((action) => action.actionTopic);

    const result = await publishAutomationActions(actions);
    if (result.sentCount <= 0) {
      return res.status(400).json({ error: 'Keine gueltigen Aktionen zum Senden vorhanden' });
    }

    res.json({ ok: true, sentCount: result.sentCount, failedCount: result.failedCount });
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
  deleteReadings,
  databaseStatus,
  optimizeDatabaseFile,
  listValueKeys,
  createValueKey,
  deleteValueKey,
  updateValueKey,
  listTopicCommands,
  updateTopicCommands,
  listTopics,
  listAutomationRules,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  testAutomationRule
};
