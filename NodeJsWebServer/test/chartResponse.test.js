const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChartResponse } = require('../public/pages/hydroponic/chart-response');
const readings = [
  { id: 1, created_at: '2026-09-01T00:00:00Z', value_text: '10' },
  { id: 2, created_at: '2026-09-17T00:00:00Z', value_text: '20' },
];

test('old server arrays remain usable without claiming complete archive coverage', () => {
  const result = normalizeChartResponse(readings, 2);
  assert.equal(result.legacy, true);
  assert.equal(result.possiblyTruncated, true);
  assert.equal(result.total, null);
  assert.equal(result.sampled, false);
  assert.deepEqual(result.readings.map((row) => row.id), [2, 1]);
  assert.equal(result.from, readings[0].created_at);
  assert.equal(result.to, readings[1].created_at);
  assert.equal(readings[0].id, 1);
  assert.equal(normalizeChartResponse([], 2000).legacy, true);
  assert.equal(normalizeChartResponse(readings, 2000).possiblyTruncated, false);
});

test('new server metadata is preserved and malformed responses are rejected clearly', () => {
  const result = normalizeChartResponse({ readings, total: 10000, sampled: true, from: 'start', to: 'end' });
  assert.equal(result.legacy, false);
  assert.equal(result.total, 10000);
  assert.equal(result.sampled, true);
  for (const value of [null, {}, { readings: {} }, [null], [{ created_at: 'not a date' }]]) {
    assert.throws(() => normalizeChartResponse(value), /keine lesbaren Messwerte/);
  }
});
