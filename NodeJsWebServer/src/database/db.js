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

db.exec(`
  CREATE TABLE IF NOT EXISTS object_value_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id INTEGER NOT NULL,
    value_key TEXT NOT NULL,
    label TEXT,
    unit TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(object_id, value_key),
    FOREIGN KEY (object_id) REFERENCES objects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_object_value_keys_object ON object_value_keys(object_id);
`);

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

const keyColumns = db.prepare('PRAGMA table_info(object_value_keys)').all().map(c => c.name);
if (!keyColumns.includes('unit')) {
  db.exec('ALTER TABLE object_value_keys ADD COLUMN unit TEXT');
}



module.exports = db;
