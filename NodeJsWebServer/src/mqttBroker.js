const net = require('net');
const http = require('http');
const ws = require('ws');
const aedes = require('aedes')();

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


//Clkient-Status überwachen
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
});

module.exports.clients = clients;