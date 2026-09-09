const net = require('net');
const http = require('http');
const ws = require('ws');
const aedes = require('aedes')({ connectTimeout: 10000 });
const { BoundedMap } = require('./services/boundedMap');
const { limitMqttConnection } = require('./services/mqttTransportService');
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
const lastMessageLogAt = new BoundedMap({ maxEntries: 2000 });
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PACKET_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 128;
const connections = new Set();
const webSocketConnections = new Set();
let startPromise;
let stopPromise;

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

function validatePublish(topic, payload) {
  if (typeof topic !== 'string' || !topic || /[+#\u0000]/.test(topic) ||
      topic.startsWith('$SYS/') || Buffer.byteLength(topic) > 1024) {
    return Object.assign(new Error('invalid_topic'), { code: 'invalid_topic' });
  }
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    return Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' });
  }
  return null;
}

aedes.authorizePublish = (_client, packet, done) => {
  done(validatePublish(packet.topic, packet.payload));
};

function handleListenerError(name, port, error) {
  const hint = error?.code === 'EADDRINUSE'
    ? ' another broker or Node process already owns this port'
    : '';
  console.error(`[MQTT] ${name} listener failed port=${port} code=${error?.code || '-'}:${hint}`);
}

function acceptConnection(connection, request) {
  if (connections.size >= MAX_CONNECTIONS || stopPromise) {
    connection.destroy();
    return;
  }
  const transport = limitMqttConnection(connection, MAX_PACKET_BYTES);
  transport.remoteAddress ||= request?.socket?.remoteAddress;
  connections.add(transport);
  transport.once('close', () => connections.delete(transport));
  aedes.handle(transport, request);
}

const tcpServer = net.createServer(acceptConnection);
tcpServer.maxConnections = MAX_CONNECTIONS;
tcpServer.on('error', (error) => handleListenerError('TCP', TCP_PORT, error));

const httpServer = http.createServer((_req, res) => {
  res.writeHead(426, { Connection: 'close' });
  res.end('MQTT WebSocket required');
});
// Include sockets which have not completed their HTTP upgrade yet.
httpServer.on('connection', (socket) => {
  webSocketConnections.add(socket);
  socket.once('close', () => webSocketConnections.delete(socket));
});
httpServer.headersTimeout = 10000;
httpServer.requestTimeout = 15000;
httpServer.maxConnections = MAX_CONNECTIONS;
const wss = new ws.Server({ server: httpServer, maxPayload: MAX_PACKET_BYTES, perMessageDeflate: false });
wss.on('connection', (socket, request) => {
  acceptConnection(ws.createWebSocketStream(socket), request);
});
httpServer.on('error', (error) => handleListenerError('WebSocket', WS_PORT, error));

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function startMqttBroker({ tcpPort = Number(TCP_PORT), wsPort = Number(WS_PORT), host = '0.0.0.0' } = {}) {
  if (startPromise) return startPromise;
  if (stopPromise) return Promise.reject(new Error('MQTT broker already stopped'));
  startPromise = (async () => {
    const results = await Promise.allSettled([
      listen(tcpServer, tcpPort, host), listen(httpServer, wsPort, host),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      await stopMqttBroker();
      throw failed.reason;
    }
    console.log(`[MQTT] Broker TCP läuft auf ${results[0].value.port}`);
    console.log(`[MQTT] Broker WS läuft auf ${results[1].value.port}`);
    return { tcp: results[0].value, ws: results[1].value };
  })();
  return startPromise;
}

function stopMqttBroker() {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    for (const connection of connections) connection.destroy();
    for (const socket of wss.clients) socket.terminate();
    for (const socket of webSocketConnections) socket.destroy();
    await Promise.all([
      new Promise((resolve) => aedes.close(resolve)),
      new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve) => tcpServer.close(resolve)),
      new Promise((resolve) => httpServer.close(resolve)),
    ]);
    clients.clear();
    topics.clear();
    lastMessageLogAt.clear();
  })();
  return stopPromise;
}


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
const clients = new BoundedMap({ maxEntries: 2000 });
const topics = new BoundedMap({
  maxEntries: 2000,
  maxWeight: 8 * 1024 * 1024,
  weigh: (data, topic) => Buffer.byteLength(topic) + Buffer.byteLength(data.lastMessage) + 64,
});

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
  if (p.topic.startsWith('$SYS/') || p.payload.length > MAX_PAYLOAD_BYTES) return;
  const payloadStr = p.payload.toString();
  if (c) {
    touchClient(c, { connected: true, lastTopic: p.topic, disconnectReason: null });
    if (shouldLogMessage(c.id, p.topic)) {
      const preview = payloadStr.length > 1024 ? `${payloadStr.slice(0, 1024)} ... [gekuerzt]` : payloadStr;
      console.log(`[MQTT] ${c.id} -> ${p.topic}: ${preview}`);
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
  const data = Buffer.from(String(payload));
  const validationError = validatePublish(topic, data);
  if (validationError) return Promise.reject(validationError);
  if (stopPromise) return Promise.reject(new Error('MQTT broker is stopping'));
  return new Promise((resolve, reject) => {
    aedes.publish(
      {
        ...opts,
        topic,
        payload: data,
        qos: opts.qos ?? 0,
        retain: Boolean(opts.retain)
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

module.exports = { clients, publish, topics, getClientSnapshot, listClientSnapshots, isClientConnected, startMqttBroker, stopMqttBroker };
