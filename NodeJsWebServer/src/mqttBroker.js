const net = require('net');
const http = require('http');
const ws = require('ws');
const aedes = require('aedes')();
const db = require('./database/db');

const TCP_PORT = process.env.MQTT_TCP_PORT || 1883;
const WS_PORT  = process.env.MQTT_WS_PORT  || 8883;
const USER = process.env.MQTT_USER;
const PASS = process.env.MQTT_PASS;

// Auth: nur wenn USER/PASS gesetzt
aedes.authenticate = (client, username, password, done) => {
  const ok =
    USER &&
    PASS &&
    username === USER &&
    Buffer.isBuffer(password) &&
    password.toString() === PASS;
  if (!ok) {
    const err = new Error('Auth failed');
    err.returnCode = 4; // ConnAck "Bad user name or password"
    return done(err, false);
  }
  return done(null, true);
};

// Optional: Publish/Subscribe-Hooks, z. B. alle erlauben
// aedes.authorizeSubscribe = (client, sub, done) => done(null, sub);
// aedes.authorizePublish = (client, packet, done) => done(null);

net.createServer(aedes.handle).listen(TCP_PORT, () => {
  console.log(`[MQTT] Broker TCP läuft auf ${TCP_PORT}`);
});

const httpServer = http.createServer();
const wss = new ws.Server({ server: httpServer });
wss.on('connection', (stream) => aedes.handle(stream));
httpServer.listen(WS_PORT, () => {
  console.log(`[MQTT] Broker WS läuft auf ${WS_PORT}`);
});


function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractValue(payload, key) {
  if (!key) return String(payload ?? '');
  const text = String(payload ?? '');
  const re = new RegExp(`${escapeRegExp(key)}\\s*=\\s*([^,]+)`, 'g');
  let match, last;
  while ((match = re.exec(text)) !== null) last = match[1].trim();
  return last ?? '';
}

function getKeysForObject(objectId, fallbackKey) {
  const rows = db
    .prepare('SELECT value_key FROM object_value_keys WHERE object_id = ? ORDER BY id ASC')
    .all(objectId);
  if (rows.length > 0) return rows.map((r) => r.value_key);
  if (fallbackKey) return [fallbackKey];
  return [];
}

function storeReading(topic, payload) {
  const obj = db.prepare('SELECT id, value_key FROM objects WHERE mqtt_topic = ?').get(topic);
  if (!obj) return;

  const keys = getKeysForObject(obj.id, obj.value_key);
  if (keys.length === 0) return;

  const raw = String(payload ?? '');
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO object_readings (object_id, topic, value_key, value_text, raw_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const key of keys) {
    const valueText = extractValue(raw, key);
    if (!valueText) continue;
    stmt.run(obj.id, topic, key, valueText, raw, now);
  }
}


//Client-Status überwachen
const clients = new Map();

aedes.on('client', (c) => {
  clients.set(c.id, { connected: true, last: Date.now() });
  console.log('[MQTT] client connected', c.id);
});
aedes.on('clientDisconnect', (c) => {
  const entry = clients.get(c.id) || {};
  clients.set(c.id, { ...entry, connected: false, last: Date.now() });
  console.log('[MQTT] client disconnected', c.id);
});
aedes.on('publish', (p, c) => {
  if (c) {
    clients.set(c.id, { connected: true, last: Date.now(), lastTopic: p.topic });
    console.log(`[MQTT] ${c.id} -> ${p.topic}: ${p.payload.toString()}`);
  }
  try {
    storeReading(p.topic, p.payload.toString());
  } catch (e) {
    console.error('[MQTT] storeReading error', e);
  }
});


function publish(topic, payload, opts = {}) {
  return new Promise((resolve, reject) => {
    aedes.publish(
      {
        topic,
        payload: Buffer.from(String(payload)),
        qos: 0,
        retain: false,
        ...opts
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

module.exports = { clients, publish };
