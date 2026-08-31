const db = require("../database/db");
const { publish } = require("../mqttBroker");

const POLL_MS = 15000;
let timer = null;
let running = false;

const latestValueReading = db.prepare(`
  SELECT value_text
  FROM object_readings
  WHERE object_id = ? AND value_key = ?
  ORDER BY id DESC
  LIMIT 1
`);
const updateRuleAfterFire = db.prepare(`
  UPDATE object_automation_rules
  SET last_condition_state = ?, last_fired_at = ?, updated_at = ?
  WHERE id = ?
`);
const updateRuleState = db.prepare(`
  UPDATE object_automation_rules
  SET last_condition_state = ?, updated_at = ?
  WHERE id = ?
`);
const updateRuleFiredAt = db.prepare(`
  UPDATE object_automation_rules
  SET last_fired_at = ?, updated_at = ?
  WHERE id = ?
`);
const activeRulesWithActions = db.prepare(`
  SELECT r.id, r.object_id, r.enabled, r.trigger_type, r.value_key, r.operator,
         r.compare_value, r.schedule_time, r.weekdays_json, r.window_start,
         r.window_end, r.cooldown_seconds, r.hysteresis_value,
         r.last_fired_at, r.last_condition_state,
         a.position, a.action_type, a.action_label, a.action_topic, a.action_payload
  FROM object_automation_rules r
  LEFT JOIN object_automation_rule_actions a ON a.rule_id = r.id
  WHERE r.enabled = 1
  ORDER BY r.id ASC, a.position ASC, a.id ASC
`);

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

  const reading = latestValueReading.get(rule.object_id, rule.value_key);

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
    updateRuleAfterFire.run(currentState, fired ? nowIso : rule.last_fired_at, nowIso, rule.id);
    return;
  }

  if (currentState !== previousState) {
    updateRuleState.run(currentState, nowIso, rule.id);
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
  updateRuleFiredAt.run(nowIso, nowIso, rule.id);
}

function loadActiveRules() {
  const rulesById = new Map();
  for (const row of activeRulesWithActions.all()) {
    let rule = rulesById.get(row.id);
    if (!rule) {
      rule = { ...row, actions: [] };
      delete rule.position;
      delete rule.action_type;
      delete rule.action_label;
      delete rule.action_topic;
      delete rule.action_payload;
      rulesById.set(row.id, rule);
    }
    if (row.action_topic) {
      rule.actions.push({
        position: row.position,
        action_type: row.action_type,
        action_label: row.action_label,
        action_topic: row.action_topic,
        action_payload: row.action_payload,
      });
    }
  }
  return [...rulesById.values()];
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
