const db = require('../database/db');
const { publishAutomationActions } = require('../services/automationService');

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
};
