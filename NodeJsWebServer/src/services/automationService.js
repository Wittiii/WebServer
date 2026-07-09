const db = require("../database/db");
const { publish } = require("../mqttBroker");

const POLL_MS = 15000;
let timer = null;
let running = false;

function parseNumber(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMinuteKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function parseTimeOfDay(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{2}:\d{2}$/.test(text)) return null;
  const [hours, minutes] = text.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function getCooldownMs(rule) {
  const seconds = Number(rule.cooldown_seconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds * 1000;
}

function isCooldownActive(rule, now) {
  const cooldownMs = getCooldownMs(rule);
  if (cooldownMs <= 0 || !rule.last_fired_at) return false;
  const lastFiredMs = new Date(rule.last_fired_at).getTime();
  if (!Number.isFinite(lastFiredMs)) return false;
  return now.getTime() - lastFiredMs < cooldownMs;
}

function isWeekdayAllowed(rule, now) {
  const raw = String(rule.weekdays_json ?? "").trim();
  if (!raw) return true;

  let weekdays;
  try {
    weekdays = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!Array.isArray(weekdays) || weekdays.length === 0) return true;
  const normalized = weekdays
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

  if (normalized.length === 0) return false;
  return normalized.includes(now.getDay());
}

function isWithinTimeWindow(rule, now) {
  const startMinutes = parseTimeOfDay(rule.window_start);
  const endMinutes = parseTimeOfDay(rule.window_end);

  if (startMinutes === null && endMinutes === null) return true;
  if (startMinutes === null || endMinutes === null) return false;
  if (startMinutes === endMinutes) return true;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function isRuleAllowedNow(rule, now) {
  return isWeekdayAllowed(rule, now) && isWithinTimeWindow(rule, now);
}

function evaluatePlainComparison(currentValue, compareValue, operator) {
  const currentNum = parseNumber(currentValue);
  const compareNum = parseNumber(compareValue);

  if (currentNum !== null && compareNum !== null) {
    switch (operator) {
      case ">":
        return currentNum > compareNum;
      case ">=":
        return currentNum >= compareNum;
      case "<":
        return currentNum < compareNum;
      case "<=":
        return currentNum <= compareNum;
      case "=":
      case "==":
        return currentNum === compareNum;
      case "!=":
        return currentNum !== compareNum;
      default:
        return false;
    }
  }

  const left = String(currentValue ?? "");
  const right = String(compareValue ?? "");
  switch (operator) {
    case "=":
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return null;
  }
}

function computeValueState(rule, readingValue, previousState) {
  const operator = rule.operator;
  const compareValue = rule.compare_value;
  const hysteresis = Number(rule.hysteresis_value || 0);
  const currentNum = parseNumber(readingValue);
  const compareNum = parseNumber(compareValue);
  const hadState = previousState === 1;
  const numericOperator = [">", ">=", "<", "<="].includes(operator);

  if (numericOperator) {
    if (currentNum === null || compareNum === null) {
      return null;
    }

    if (operator === ">" || operator === ">=") {
      const enter = operator === ">" ? currentNum > compareNum : currentNum >= compareNum;
      const leave = currentNum < compareNum - hysteresis;
      return hadState ? (leave ? 0 : 1) : (enter ? 1 : 0);
    }

    if (operator === "<" || operator === "<=") {
      const enter = operator === "<" ? currentNum < compareNum : currentNum <= compareNum;
      const leave = currentNum > compareNum + hysteresis;
      return hadState ? (leave ? 0 : 1) : (enter ? 1 : 0);
    }
  }

  if ((operator === "=" || operator === "==" || operator === "!=") && currentNum !== null && compareNum !== null && hysteresis > 0) {
    const delta = Math.abs(currentNum - compareNum);
    if (operator === "=" || operator === "==") {
      return delta <= hysteresis ? 1 : 0;
    }
    return delta > hysteresis ? 1 : 0;
  }

  return evaluatePlainComparison(readingValue, compareValue, operator);
}

async function publishAutomationActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { sentCount: 0, failedCount: 0 };
  }

  let sentCount = 0;
  let failedCount = 0;
  for (const action of actions) {
    const topic = String(action.action_topic ?? action.actionTopic ?? "").trim();
    if (!topic) continue;
    try {
      await publish(topic, String(action.action_payload ?? action.actionPayload ?? ""));
      sentCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error("[automation] action publish failed", topic, error);
    }
  }

  return { sentCount, failedCount };
}

async function fireActions(actions) {
  const result = await publishAutomationActions(actions);
  return result.sentCount > 0;
}

async function evaluateValueRule(rule, now) {
  if (!rule.value_key || !rule.operator) return;

  const reading = db.prepare(`
    SELECT value_text
    FROM object_readings
    WHERE object_id = ? AND value_key = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(rule.object_id, rule.value_key);

  if (!reading) return;

  const previousState = Number.isFinite(rule.last_condition_state) ? rule.last_condition_state : 0;
  const baseState = computeValueState(rule, reading.value_text, previousState);
  if (baseState === null) {
    return;
  }
  const currentState = baseState === 1 && isRuleAllowedNow(rule, now) ? 1 : 0;

  const entersCondition = currentState === 1 && previousState !== 1;
  const nowIso = now.toISOString();

  if (entersCondition && !isCooldownActive(rule, now)) {
    const fired = await fireActions(rule.actions);
    db.prepare(`
      UPDATE object_automation_rules
      SET last_condition_state = ?, last_fired_at = ?, updated_at = ?
      WHERE id = ?
    `).run(currentState, fired ? nowIso : rule.last_fired_at, nowIso, rule.id);
    return;
  }

  if (currentState !== previousState) {
    db.prepare(`
      UPDATE object_automation_rules
      SET last_condition_state = ?, updated_at = ?
      WHERE id = ?
    `).run(currentState, nowIso, rule.id);
  }
}

async function evaluateTimeRule(rule, now) {
  if (!rule.schedule_time) return;
  if (!isRuleAllowedNow(rule, now)) return;

  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (currentTime !== rule.schedule_time) return;

  const minuteKey = getMinuteKey(now);
  const lastMinuteKey = rule.last_fired_at ? getMinuteKey(new Date(rule.last_fired_at)) : "";
  if (lastMinuteKey === minuteKey || isCooldownActive(rule, now)) return;

  const fired = await fireActions(rule.actions);
  if (!fired) return;

  const nowIso = now.toISOString();
  db.prepare(`
    UPDATE object_automation_rules
    SET last_fired_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nowIso, nowIso, rule.id);
}

function loadActiveRules() {
  const rules = db.prepare(`
    SELECT id, object_id, enabled, trigger_type, value_key, operator, compare_value,
           schedule_time, weekdays_json, window_start, window_end,
           cooldown_seconds, hysteresis_value,
           last_fired_at, last_condition_state
    FROM object_automation_rules
    WHERE enabled = 1
    ORDER BY id ASC
  `).all();

  if (rules.length === 0) return [];

  const ruleIds = rules.map((rule) => rule.id);
  const placeholders = ruleIds.map(() => "?").join(", ");
  const actions = db.prepare(`
    SELECT rule_id, position, action_type, action_label, action_topic, action_payload
    FROM object_automation_rule_actions
    WHERE rule_id IN (${placeholders})
    ORDER BY rule_id ASC, position ASC, id ASC
  `).all(...ruleIds);

  const actionsByRule = new Map();
  for (const action of actions) {
    if (!actionsByRule.has(action.rule_id)) actionsByRule.set(action.rule_id, []);
    actionsByRule.get(action.rule_id).push(action);
  }

  return rules.map((rule) => ({
    ...rule,
    actions: actionsByRule.get(rule.id) || [],
  }));
}

async function processRules() {
  if (running) return;
  running = true;

  try {
    const now = new Date();
    const rules = loadActiveRules();

    for (const rule of rules) {
      try {
        if (!rule.actions.length) continue;
        if (rule.trigger_type === "value") {
          await evaluateValueRule(rule, now);
        } else if (rule.trigger_type === "time") {
          await evaluateTimeRule(rule, now);
        }
      } catch (error) {
        console.error("[automation] rule failed", rule.id, error);
      }
    }
  } finally {
    running = false;
  }
}

function startAutomationEngine() {
  if (timer) return;
  timer = setInterval(() => {
    processRules().catch((error) => {
      console.error("[automation] tick failed", error);
    });
  }, POLL_MS);
  processRules().catch((error) => {
    console.error("[automation] initial run failed", error);
  });
}

module.exports = { startAutomationEngine, publishAutomationActions };
