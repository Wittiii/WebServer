const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const logs = require('../src/services/runtimeLogService');
const { streamConsoleLogs } = require('../src/controllers/consoleController');

class Response extends EventEmitter {
  constructor() { super(); this.chunks = []; this.allowWrite = true; }
  set() { return this; }
  status(value) { this.statusCode = value; return this; }
  json(value) { this.body = value; return this; }
  flushHeaders() {}
  write(chunk) { this.chunks.push(chunk); return this.allowWrite; }
  destroy() { this.emit('close'); }
}

test('console replays log entries after backpressure and cleans up disconnected clients', () => {
  logs.installConsoleCapture();
  const after = logs.getLastId();
  const response = new Response();
  try {
    streamConsoleLogs({ query: { after }, get: () => '' }, response);
    response.allowWrite = false;
    console.log('console-backpressure-first');
    console.log('console-backpressure-second');
    assert.equal(response.chunks.some((chunk) => chunk.includes('console-backpressure-second')), false);
    response.allowWrite = true;
    response.emit('drain');
    assert.equal(response.chunks.filter((chunk) => chunk.includes('console-backpressure-first')).length, 1);
    assert.equal(response.chunks.filter((chunk) => chunk.includes('console-backpressure-second')).length, 1);
    response.destroy();
    const count = response.chunks.length;
    console.log('console-after-close');
    assert.equal(response.chunks.length, count);
    assert.equal(response.listenerCount('drain'), 0);
  } finally { response.destroy(); }
});

test('console limits concurrent streams and releases slots when they disconnect', () => {
  const responses = Array.from({ length: 11 }, () => new Response());
  try {
    for (const response of responses) streamConsoleLogs({ query: {}, get: () => '' }, response);
    assert.equal(responses[10].statusCode, 503);
    responses[0].destroy();
    const retry = new Response();
    streamConsoleLogs({ query: {}, get: () => '' }, retry);
    assert.equal(retry.statusCode, undefined);
    retry.destroy();
  } finally { for (const response of responses) response.destroy(); }
});
