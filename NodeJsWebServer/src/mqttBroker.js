const net = require('net');
const http = require('http');
const ws = require('ws');
const aedes = require('aedes')();
const db = require('./database/db');
const { ingestPowerMeterMessage } = require('./services/powerMeterService');
const { ingestVictronMessage } = require('./services/victronMpptService');
const { createValueExtractor } = require('./services/mqttPayloadService');

const TCP_PORT = process.env.MQTT_TCP_PORT || 1883;
const WS_PORT  = process.env.MQTT_WS_PORT  || 8883;
const USER = process.env.MQTT_USER;
const PASS = process.env.MQTT_PASS;
const DEFAULT_CLIENT_STALE_MS = Math.max(15000, Number(process.env.MQTT_CLIENT_STALE_MS || 120000));
const logMessagePayloads = String(process.env.MQTT_LOG_MESSAGES || 'true').toLowerCase() !== 'false';
const logMessageIntervalMs = Math.max(0, Number(process.env.MQTT_LOG_INTERVAL_MS || 500));
const lastMessageLogAt = new Map();

function shouldLogMessage(clientId, topic, now = Date.now()) {
  if (!logMessagePayloads) return false;
  if (logMessageIntervalMs === 0) return true;
  const key = `${clientId}\0${topic}`;
  const previous = lastMessageLogAt.get(key) || 0;
  if (now - previous < logMessageIntervalMs) return false;
  lastMessageLogAt.set(key, now);
  return true;
}

// Auth: nur wenn USER/PASS gesetzt
aedes.authenticate = (client, username, password, done) => {
  const suppliedUser = Buffer.isBuffer(username)
    ? username.toString()
    : String(username || '');
  const ok =
    USER &&
    PASS &&
    suppliedUser === USER &&
    Buffer.isBuffer(password) &&
    password.toString() === PASS;
  if (!ok) {
    console.warn(
      `[MQTT] auth rejected client=${client?.id || '-'} username=${suppliedUser || '-'}`,
    );
    const err = new Error('Auth failed');
    err.returnCode = 4; // ConnAck "Bad user name or password"
    return done(err, false);
  }
  return done(null, true);
};

// Optional: Publish/Subscribe-Hooks, z. B. alle erlauben
// aedes.authorizeSubscribe = (client, sub, done) => done(null, sub);
// aedes.authorizePublish = (client, packet, done) => done(null);

function handleListenerError(name, port, error) {
  const hint = error?.code === 'EADDRINUSE'
    ? ' another broker or Node process already owns this port'
    : '';
  console.error(`[MQTT] ${name} listener failed port=${port} code=${error?.code || '-'}:${hint}`);
  throw error;
}

const tcpServer = net.createServer(aedes.handle);
tcpServer.on('error', (error) => handleListenerError('TCP', TCP_PORT, error));
tcpServer.listen(TCP_PORT, () => {
  console.log(`[MQTT] Broker TCP läuft auf ${TCP_PORT}`);
});

const httpServer = http.createServer();
const wss = new ws.Server({ server: httpServer });
wss.on('connection', (stream) => aedes.handle(stream));
httpServer.on('error', (error) => handleListenerError('WebSocket', WS_PORT, error));
httpServer.listen(WS_PORT, () => {
  console.log(`[MQTT] Broker WS läuft auf ${WS_PORT}`);
});


const findObjectsForTopic = db.prepare(`
  SELECT id, value_key FROM objects WHERE mqtt_topic = ?
  UNION
  SELECT o.id, o.value_key
  FROM object_topic_commands tc
  JOIN objects o ON o.id = tc.object_id
  WHERE tc.topic = ?
  UNION
  SELECT o.id, o.value_key
  FROM object_value_keys vk
  JOIN objects o ON o.id = vk.object_id
  WHERE vk.topic = ?
`);
const findKeysForObject = db.prepare(`
  SELECT DISTINCT value_key
  FROM object_value_keys
  WHERE object_id = ? AND (topic IS NULL OR topic = ?)
  ORDER BY id ASC
`);
const insertObjectReading = db.prepare(`
  INSERT INTO object_readings (object_id, topic, value_key, value_text, raw_payload, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function getKeysForObject(objectId, topic, fallbackKey) {
  const rows = findKeysForObject.all(objectId, topic);
  if (rows.length > 0) return rows.map((r) => r.value_key);
  if (fallbackKey) return [fallbackKey];
  return [];
}

const storeObjectReadings = db.transaction((rows, topic, raw, now, extractValue) => {
  for (const obj of rows) {
    const keys = getKeysForObject(obj.id, topic, obj.value_key);
    for (const key of keys) {
      const valueText = extractValue(key);
      if (!valueText) continue;
      insertObjectReading.run(obj.id, topic, key, valueText, raw, now);
    }
  }
});

function storeReading(topic, payload) {
  const rows = findObjectsForTopic.all(topic, topic, topic);
  if (rows.length === 0) return;

  const raw = String(payload ?? '');
  const now = new Date().toISOString();
  const extractValue = createValueExtractor(raw);

  storeObjectReadings(rows, topic, raw, now, extractValue);
}


//Client-Status überwachen
const clients = new Map();
const topics = new Map();

function getKeepaliveMs(client) {
  const value = Number(client?._keepaliveInterval || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function touchClient(client, patch = {}) {
  if (!client?.id) return;
  const entry = clients.get(client.id) || {};
  clients.set(client.id, {
    ...entry,
    id: client.id,
    connected: patch.connected ?? true,
    last: Date.now(),
    keepaliveMs: patch.keepaliveMs ?? entry.keepaliveMs ?? getKeepaliveMs(client),
    lastTopic: patch.lastTopic ?? entry.lastTopic ?? null,
    disconnectReason: patch.disconnectReason ?? entry.disconnectReason ?? null
  });
}

function markClientDisconnected(client, reason = null) {
  if (!client?.id) return;
  const entry = clients.get(client.id) || {};
  clients.set(client.id, {
    ...entry,
    id: client.id,
    connected: false,
    last: Date.now(),
    disconnectReason: reason || entry.disconnectReason || null
  });
}

function isClientConnected(data, now = Date.now()) {
  if (!data?.connected) return false;

  const last = Number(data.last || 0);
  if (!Number.isFinite(last) || last <= 0) return false;

  const keepaliveMs = Number(data.keepaliveMs || 0);
  const staleMs = keepaliveMs > 0
    ? keepaliveMs + 10000
    : DEFAULT_CLIENT_STALE_MS;

  return now - last <= staleMs;
}

function getClientSnapshot(id) {
  const entry = clients.get(id);
  if (!entry) return null;

  return {
    id,
    connected: isClientConnected(entry),
    last: entry.last || null,
    lastTopic: entry.lastTopic || null,
    keepaliveMs: entry.keepaliveMs || 0,
    disconnectReason: entry.disconnectReason || null
  };
}

function listClientSnapshots() {
  return [...clients.keys()].map((id) => getClientSnapshot(id)).filter(Boolean);
}

aedes.on('client', (c) => {
  touchClient(c, { connected: true, keepaliveMs: getKeepaliveMs(c), disconnectReason: null });
  console.log('[MQTT] client connected', c.id);
});
aedes.on('clientReady', (c) => {
  touchClient(c, { connected: true, keepaliveMs: getKeepaliveMs(c), disconnectReason: null });
  console.log('[MQTT] client ready', c.id);
});
aedes.on('clientDisconnect', (c) => {
  markClientDisconnected(c, 'disconnect');
  console.log('[MQTT] client disconnected', c.id);
});
aedes.on('keepaliveTimeout', (c) => {
  markClientDisconnected(c, 'keepalive_timeout');
  console.log('[MQTT] client keepalive timeout', c.id);
});
aedes.on('clientError', (c, error) => {
  console.error(`[MQTT] client error client=${c?.id || '-'}: ${error?.message || error}`);
});
aedes.on('connectionError', (c, error) => {
  console.error(
    `[MQTT] connection error client=${c?.id || '-'} remote=${c?.conn?.remoteAddress || '-'}: ${error?.message || error}`,
  );
});
aedes.on('ping', (_packet, c) => {
  touchClient(c, { connected: true, disconnectReason: null });
});
aedes.on('publish', (p, c) => {
  const payloadStr = p.payload.toString();
  if (c) {
    touchClient(c, { connected: true, lastTopic: p.topic, disconnectReason: null });
    if (shouldLogMessage(c.id, p.topic)) {
      console.log(`[MQTT] ${c.id} -> ${p.topic}: ${payloadStr}`);
    }
  }
  topics.set(p.topic, { lastMessage: payloadStr, timestamp: Date.now() });
  try {
    ingestPowerMeterMessage(p.topic, payloadStr);
  } catch (e) {
    console.error('[MQTT] power meter ingest error', e);
  }
  try {
    ingestVictronMessage(p.topic, payloadStr);
  } catch (e) {
    console.error('[MQTT] Victron MPPT ingest error', e);
  }
  try {
    storeReading(p.topic, payloadStr);
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

module.exports = { clients, publish, topics, getClientSnapshot, listClientSnapshots, isClientConnected };
