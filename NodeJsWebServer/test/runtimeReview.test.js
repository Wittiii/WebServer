const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const { MqttPacketLimit } = require('../src/services/mqttTransportService');

test('packet guard preserves bytes across fragmented headers and concatenated packets', async () => {
  const limiter = new MqttPacketLimit(256);
  const received = [];
  limiter.on('data', (chunk) => received.push(chunk));
  const completion = finished(limiter);
  const chunks = [Buffer.from([0x30]), Buffer.from([0x80]), Buffer.from([0x01]), Buffer.alloc(64), Buffer.concat([Buffer.alloc(64), Buffer.from([0xc0, 0])])];
  for (const chunk of chunks) limiter.write(chunk);
  limiter.end();
  await completion;
  assert.deepEqual(Buffer.concat(received), Buffer.concat(chunks));
});

test('packet guard rejects an oversized Remaining Length without receiving the body', async () => {
  const limiter = new MqttPacketLimit(128);
  limiter.resume();
  const rejected = assert.rejects(finished(limiter), { code: 'MQTT_PACKET_TOO_LARGE' });
  limiter.write(Buffer.from([0x30, 0x80]));
  limiter.end(Buffer.from([0x01]));
  await rejected;
});

test('MQTT shutdown closes incomplete WebSocket HTTP handshakes promptly', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-runtime-review-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  process.env.SQLITE_JOURNAL_MODE = 'DELETE';
  process.env.MQTT_USER = 'runtime-review';
  process.env.MQTT_PASS = 'test-only-password';
  const broker = require('../src/mqttBroker');
  const db = require('../src/database/db');
  t.after(async () => {
    await broker.stopMqttBroker();
    db.close();
    fs.unlinkSync(process.env.DATABASE_PATH);
    fs.rmdirSync(directory);
  });
  const addresses = await broker.startMqttBroker({ tcpPort: 0, wsPort: 0, host: '127.0.0.1' });
  const client = net.createConnection({ port: addresses.ws.port, host: '127.0.0.1' });
  client.on('error', () => {});
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write('GET /mqtt HTTP/1.1\r\nHost: localhost\r\n');
  // Give the listener a chance to receive this deliberately incomplete header.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stopping = broker.stopMqttBroker();
  let timer;
  const promptlyStopped = await Promise.race([
    stopping.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
  ]);
  clearTimeout(timer);
  client.destroy();
  await stopping;
  assert.equal(promptlyStopped, true, 'a half-open HTTP handshake must not hold shutdown until the global kill timeout');
});
