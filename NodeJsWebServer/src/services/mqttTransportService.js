const { Transform, Duplex } = require('node:stream');

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

function limitMqttConnection(connection, maxBytes) {
  const limiter = new MqttPacketLimit(maxBytes);
  connection.pipe(limiter);
  const transport = Duplex.from({ readable: limiter, writable: connection });
  transport.remoteAddress = connection.remoteAddress;
  transport.on('error', () => connection.destroy());
  transport.once('close', () => {
    connection.destroy();
    limiter.destroy();
  });
  connection.once('close', () => transport.destroy());
  return transport;
}

module.exports = { MqttPacketLimit, limitMqttConnection };
