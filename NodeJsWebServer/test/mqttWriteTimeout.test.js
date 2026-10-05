const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { once } = require('node:events');
const mqtt = require('mqtt-packet');
const { limitMqttConnection } = require('../src/services/mqttTransportService');

class ControlledConnection extends Duplex {
  constructor() {
    super();
    this.frozen = false;
    this.writeDelayMs = 0;
    this.writes = [];
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    if (!this.frozen) {
      if (this.writeDelayMs) setTimeout(callback, this.writeDelayMs);
      else callback();
    }
  }
  receive(packet) { this.push(mqtt.generate(packet)); }
}

async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { clearTimeout(timer); }
}

test('a frozen outbound connection is closed after its write timeout', async (t) => {
  const connection = new ControlledConnection();
  connection.frozen = true;
  const transport = limitMqttConnection(connection, 128 * 1024, { writeTimeoutMs: 30 });
  t.after(() => transport.destroy());
  const error = once(transport, 'error');
  assert.equal(transport.write(Buffer.alloc(256 * 1024)), false);
  const result = await within(error, 300);
  assert.equal(result?.[0]?.code, 'MQTT_WRITE_TIMEOUT');
  assert.equal(transport.destroyed, true);
  assert.equal(connection.destroyed, true);
});

test('a draining connection cancels its timeout and preserves outgoing bytes', async (t) => {
  const connection = new ControlledConnection();
  connection.writeDelayMs = 5;
  const transport = limitMqttConnection(connection, 128 * 1024, { writeTimeoutMs: 20 });
  t.after(() => transport.destroy());
  let errors = 0;
  transport.on('error', () => { errors++; });
  const bytes = Buffer.alloc(256 * 1024, 42);
  const drain = once(transport, 'drain');
  assert.equal(transport.write(bytes), false);
  await drain;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(errors, 0);
  assert.equal(transport.destroyed, false);
  assert.deepEqual(Buffer.concat(connection.writes), bytes);
});

test('Aedes publishes continue after a frozen subscriber with keepalive zero is disconnected', async (t) => {
  const broker = require('aedes')({ connectTimeout: 1000 });
  const transports = [];
  broker.on('clientError', () => {});
  broker.on('connectionError', () => {});
  t.after(async () => {
    for (const transport of transports) transport.destroy();
    await new Promise((resolve) => broker.close(resolve));
  });
  async function subscribe(id) {
    const connection = new ControlledConnection();
    const transport = limitMqttConnection(connection, 128 * 1024, { writeTimeoutMs: 40 });
    transports.push(transport);
    const ready = once(broker, 'clientReady');
    broker.handle(transport);
    connection.receive({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: true, clientId: id, keepalive: 0 });
    const [client] = await ready;
    assert.equal(client._keepaliveTimer == null, true, 'keepalive zero has no safety timer');
    const subscribed = once(broker, 'subscribe');
    connection.receive({ cmd: 'subscribe', qos: 1, messageId: 1, subscriptions: [{ topic: 'test/outbound-timeout', qos: 0 }] });
    await subscribed;
    return connection;
  }
  const frozen = await subscribe('frozen');
  const healthy = await subscribe('healthy');
  frozen.frozen = true;
  const publish = (payload) => new Promise((resolve, reject) => broker.publish({
    topic: 'test/outbound-timeout', payload, qos: 0, retain: false,
  }, (error) => error ? reject(error) : resolve(true)));
  assert.equal(await within(publish(Buffer.alloc(64 * 1024, 42)), 500), true,
    'a stalled subscriber must release the broker publish callback');
  assert.equal(frozen.destroyed, true);
  assert.equal(healthy.destroyed, false);
  assert.equal(await within(publish('following message'), 300), true);
  const packets = [];
  const parser = mqtt.parser();
  parser.on('packet', (packet) => packets.push(packet));
  parser.parse(Buffer.concat(healthy.writes));
  assert.equal(packets.filter((packet) => packet.cmd === 'publish').at(-1).payload.toString(), 'following message');
});
