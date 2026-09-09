const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { BoundedMap } = require('../src/services/boundedMap');
const { MqttPacketLimit } = require('../src/services/mqttTransportService');
const mqtt = require('mqtt-packet');
const ws = require('ws');

test('MQTT caches bound both total bytes and entry count when keys change', () => {
  const cache = new BoundedMap({ maxEntries: 2, maxWeight: 10, weigh: (value) => value.length });
  cache.set('a', '1234').set('b', '1234').set('a', '12').set('c', '1234');
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  assert.equal(cache.weight, 6);
  cache.set('d', '123456789');
  assert.deepEqual([...cache.keys()], ['d']);
  cache.set('d', '12345678901');
  assert.equal(cache.size, 0);
  cache.set('x', 'x');
  cache.clear();
  assert.equal(cache.weight, 0);
});

test('packet limit passes fragmented and combined MQTT frames unchanged', async () => {
  const packets = Buffer.concat([
    mqtt.generate({ cmd: 'pingreq' }),
    mqtt.generate({ cmd: 'publish', topic: 'sensors/test', payload: Buffer.alloc(300, 128), qos: 0 }),
    mqtt.generate({ cmd: 'disconnect' }),
  ]);
  const stream = new MqttPacketLimit(1024);
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  const ended = once(stream, 'end');
  for (let i = 0; i < packets.length; i += 3) stream.write(packets.subarray(i, i + 3));
  stream.end();
  await ended;
  assert.deepEqual(Buffer.concat(chunks), packets);
});

test('packet limit rejects oversized declarations before receiving payloads', async () => {
  const stream = new MqttPacketLimit(1024);
  const error = once(stream, 'error');
  stream.write(Buffer.from([0x30, 0xff]));
  stream.write(Buffer.from([0x7f]));
  assert.equal((await error)[0].code, 'MQTT_PACKET_TOO_LARGE');
});

function receivePacket(stream) {
  const parser = mqtt.parser();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('MQTT response timed out')), 4000);
    const parse = (chunk) => parser.parse(chunk);
    const fail = (error) => finish(error);
    function finish(error, packet) {
      clearTimeout(timer);
      stream.removeListener('data', parse);
      stream.removeListener('error', fail);
      error ? reject(error) : resolve(packet);
    }
    parser.once('packet', (packet) => finish(null, packet));
    parser.once('error', fail);
    stream.on('data', parse);
    stream.once('error', fail);
  });
}

test('real broker authenticates TCP and WS, rejects invalid packets and shuts down', { timeout: 15000 }, async () => {
  // db.js resolves paths; use a genuine temporary database, never the workspace DB.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-runtime-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  process.env.MQTT_USER = 'test-user';
  process.env.MQTT_PASS = 'test-password';
  process.env.MQTT_LOG_MESSAGES = 'false';
  const broker = require('../src/mqttBroker');
  const db = require('../src/database/db');
  const streams = [];
  try {
    const addObject = db.prepare('INSERT INTO objects (name, created_at, mqtt_topic, value_key) VALUES (?, ?, ?, ?)');
    for (const index of [0, 1]) addObject.run(`test-${index}`, new Date().toISOString(), `test/${index}`, '$value');
    const address = await broker.startMqttBroker({ host: '127.0.0.1', tcpPort: 0, wsPort: 0 });
    const tcp = net.connect(address.tcp.port, '127.0.0.1');
    streams.push(tcp);
    await once(tcp, 'connect');
    const websocket = new ws(`ws://127.0.0.1:${address.ws.port}`, 'mqtt');
    await once(websocket, 'open');
    const duplex = ws.createWebSocketStream(websocket);
    streams.push(duplex);
    for (const [index, stream] of streams.entries()) {
      const reply = receivePacket(stream);
      stream.write(mqtt.generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4,
        clean: true, clientId: `test-${index}`, keepalive: 30, username: 'test-user', password: 'test-password' }));
      assert.equal((await reply).returnCode, 0);
      const ping = receivePacket(stream);
      stream.write(mqtt.generate({ cmd: 'pingreq' }));
      assert.equal((await ping).cmd, 'pingresp');
      const published = receivePacket(stream);
      stream.write(mqtt.generate({ cmd: 'publish', topic: `test/${index}`, payload: '42', qos: 1, messageId: index + 1 }));
      assert.equal((await published).cmd, 'puback');
    }
    await broker.publish('test/internal', '123');
    assert.equal(broker.topics.get('test/internal').lastMessage, '123');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM object_readings WHERE value_text = '42'").get().n, 2);
    await assert.rejects(broker.publish('test/+', '123'), /invalid_topic/);
    await assert.rejects(broker.publish('test/huge', 'a'.repeat(65537)), /payload_too_large/);
    const unauthenticated = net.connect(address.tcp.port, '127.0.0.1');
    streams.push(unauthenticated);
    await once(unauthenticated, 'connect');
    const reply = receivePacket(unauthenticated);
    unauthenticated.write(mqtt.generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4,
      clean: true, clientId: 'bad-auth', username: 'test-user', password: 'wrong' }));
    assert.equal((await reply).returnCode, 4);
    const oversized = net.connect(address.tcp.port, '127.0.0.1');
    streams.push(oversized);
    await once(oversized, 'connect');
    const closed = once(oversized, 'close');
    oversized.write(Buffer.from([0x30, 0xff, 0xff, 0x7f]));
    await closed;
  } finally {
    for (const stream of streams) stream.destroy();
    await broker.stopMqttBroker();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
