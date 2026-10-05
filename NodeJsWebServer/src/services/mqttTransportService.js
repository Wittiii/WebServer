const { Transform, Duplex } = require('node:stream');
const DEFAULT_WRITE_TIMEOUT_MS = 60000;

// Check MQTT's Remaining Length before the broker buffers the packet body.
// State survives TCP/WS chunk boundaries; payload bytes are never re-parsed.
class MqttPacketLimit extends Transform {
  constructor(maxBytes = 128 * 1024) {
    super();
    this.maxBytes = maxBytes;
    this.state = 'header';
    this.remaining = 0;
    this.lengthBytes = 0;
  }

  _transform(chunk, _encoding, callback) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.state === 'body') {
        const consumed = Math.min(this.remaining, chunk.length - offset);
        offset += consumed;
        this.remaining -= consumed;
        if (this.remaining === 0) this.state = 'header';
      } else if (this.state === 'header') {
        offset += 1;
        this.state = 'length';
        this.remaining = 0;
        this.lengthBytes = 0;
      } else {
        const byte = chunk[offset++];
        this.remaining += (byte & 127) * (128 ** this.lengthBytes++);
        if (this.remaining + this.lengthBytes + 1 > this.maxBytes ||
            (this.lengthBytes === 4 && (byte & 128))) {
          const error = new Error('MQTT packet exceeds limit or has invalid length');
          error.code = 'MQTT_PACKET_TOO_LARGE';
          return callback(error);
        }
        if (!(byte & 128)) this.state = this.remaining ? 'body' : 'header';
      }
    }
    callback(null, chunk);
  }
}

function limitMqttConnection(connection, maxBytes, { writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS } = {}) {
  const limiter = new MqttPacketLimit(maxBytes);
  connection.pipe(limiter);
  const transport = Duplex.from({ readable: limiter, writable: connection });
  const timeoutMs = Number.isFinite(writeTimeoutMs) && writeTimeoutMs > 0
    ? Math.min(300000, Math.max(1, Math.trunc(writeTimeoutMs))) : DEFAULT_WRITE_TIMEOUT_MS;
  let writeTimer = null;
  const clearWriteTimer = () => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
  };
  const write = transport.write;
  transport.write = function (...args) {
    const accepted = write.apply(this, args);
    // Aedes 0.x waits indefinitely for drain after backpressure. Disconnect
    // just this stalled client; Aedes.close() releases its pending drain jobs.
    if (!accepted && !this.destroyed && !writeTimer) {
      writeTimer = setTimeout(() => {
        writeTimer = null;
        const error = new Error('MQTT outbound write did not drain before timeout');
        error.code = 'MQTT_WRITE_TIMEOUT';
        transport.destroy(error);
      }, timeoutMs);
      writeTimer.unref();
    }
    return accepted;
  };
  transport.remoteAddress = connection.remoteAddress;
  transport.on('drain', clearWriteTimer);
  transport.on('error', () => {
    clearWriteTimer();
    connection.destroy();
  });
  transport.once('close', () => {
    clearWriteTimer();
    connection.destroy();
    limiter.destroy();
  });
  connection.once('close', () => transport.destroy());
  return transport;
}

module.exports = { MqttPacketLimit, limitMqttConnection, DEFAULT_WRITE_TIMEOUT_MS };
