const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    mqtt_topic TEXT,
    commands TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS object_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    value_key TEXT,
    value_text TEXT NOT NULL,
    raw_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (object_id) REFERENCES objects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_object_readings_object ON object_readings(object_id);
  CREATE INDEX IF NOT EXISTS idx_object_readings_topic ON object_readings(topic);
`)

const haveValueKeys = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='object_value_keys'").get();
const keyColumns = haveValueKeys ? db.prepare('PRAGMA table_info(object_value_keys)').all().map(c => c.name) : [];

if (!haveValueKeys) {
  db.exec(`
    CREATE TABLE object_value_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      topic TEXT,
      value_key TEXT NOT NULL,
      label TEXT,
      unit TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(object_id, topic, value_key),
      FOREIGN KEY (object_id) REFERENCES objects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_object_value_keys_object ON object_value_keys(object_id);
  `);
} else if (!keyColumns.includes('topic')) {
  db.exec('BEGIN');
  db.exec(`
    CREATE TABLE object_value_keys_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      topic TEXT,
      value_key TEXT NOT NULL,
      label TEXT,
      unit TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(object_id, topic, value_key),
      FOREIGN KEY (object_id) REFERENCES objects(id)
    );
  `);
  db.exec(`
    INSERT INTO object_value_keys_new (id, object_id, topic, value_key, label, unit, created_at)
    SELECT id, object_id, NULL, value_key, label, unit, created_at
    FROM object_value_keys;
  `);
  db.exec('DROP TABLE object_value_keys;');
  db.exec('ALTER TABLE object_value_keys_new RENAME TO object_value_keys;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_object_value_keys_object ON object_value_keys(object_id);');
  db.exec('COMMIT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS object_topic_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    commands TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(object_id, topic),
    FOREIGN KEY (object_id) REFERENCES objects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_object_topic_commands_object ON object_topic_commands(object_id);
  CREATE INDEX IF NOT EXISTS idx_object_topic_commands_topic ON object_topic_commands(topic);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_dashboard_widgets (
    username TEXT PRIMARY KEY,
    widgets TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS power_meter_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    source_time TEXT,
    total_start_time TEXT,
    total_kwh REAL NOT NULL,
    yesterday_kwh REAL NOT NULL,
    today_kwh REAL NOT NULL,
    power_w REAL NOT NULL,
    apparent_power_va REAL NOT NULL,
    reactive_power_var REAL NOT NULL,
    power_factor REAL NOT NULL,
    voltage_v REAL NOT NULL,
    current_a REAL NOT NULL,
    received_at_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_power_meter_topic_time
    ON power_meter_readings(topic, received_at_ms);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS object_automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_type TEXT NOT NULL,
    value_key TEXT,
    operator TEXT,
    compare_value TEXT,
    schedule_time TEXT,
    weekdays_json TEXT,
    window_start TEXT,
    window_end TEXT,
    action_type TEXT NOT NULL,
    action_label TEXT,
    action_topic TEXT NOT NULL,
    action_payload TEXT,
    last_fired_at TEXT,
    last_condition_state INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (object_id) REFERENCES objects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_object_automation_rules_object ON object_automation_rules(object_id);
  CREATE INDEX IF NOT EXISTS idx_object_automation_rules_enabled ON object_automation_rules(enabled);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS object_automation_rule_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL,
    action_label TEXT,
    action_topic TEXT NOT NULL,
    action_payload TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (rule_id) REFERENCES object_automation_rules(id)
  );
  CREATE INDEX IF NOT EXISTS idx_object_automation_rule_actions_rule ON object_automation_rule_actions(rule_id);
`);

const automationColumns = db.prepare('PRAGMA table_info(object_automation_rules)').all().map(c => c.name);
if (!automationColumns.includes('cooldown_seconds')) {
  db.exec('ALTER TABLE object_automation_rules ADD COLUMN cooldown_seconds INTEGER NOT NULL DEFAULT 0');
}
if (!automationColumns.includes('hysteresis_value')) {
  db.exec('ALTER TABLE object_automation_rules ADD COLUMN hysteresis_value REAL');
}
if (!automationColumns.includes('weekdays_json')) {
  db.exec('ALTER TABLE object_automation_rules ADD COLUMN weekdays_json TEXT');
}
if (!automationColumns.includes('window_start')) {
  db.exec('ALTER TABLE object_automation_rules ADD COLUMN window_start TEXT');
}
if (!automationColumns.includes('window_end')) {
  db.exec('ALTER TABLE object_automation_rules ADD COLUMN window_end TEXT');
}

db.exec(`
  INSERT INTO object_automation_rule_actions (
    rule_id, position, action_type, action_label, action_topic, action_payload, created_at, updated_at
  )
  SELECT r.id, 0, COALESCE(r.action_type, 'custom'), r.action_label, r.action_topic, r.action_payload,
         COALESCE(r.created_at, CURRENT_TIMESTAMP), COALESCE(r.updated_at, CURRENT_TIMESTAMP)
  FROM object_automation_rules r
  LEFT JOIN object_automation_rule_actions a ON a.rule_id = r.id
  WHERE a.rule_id IS NULL
    AND r.action_topic IS NOT NULL
    AND TRIM(r.action_topic) <> ''
`);

const columns = db.prepare('PRAGMA table_info(objects)').all().map(c => c.name);

if (!columns.includes('value_key')) {
  db.exec('ALTER TABLE objects ADD COLUMN value_key TEXT');
}
if (!columns.includes('mqtt_topic')) {
  db.exec('ALTER TABLE objects ADD COLUMN mqtt_topic TEXT');
}
if (!columns.includes('commands')) {
  db.exec('ALTER TABLE objects ADD COLUMN commands TEXT');
}




module.exports = db;
