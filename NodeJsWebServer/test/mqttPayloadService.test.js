const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createValueExtractor,
  extractValue,
} = require("../src/services/mqttPayloadService");

test("reuses one parsed JSON payload for multiple configured keys", () => {
  const extract = createValueExtractor(JSON.stringify({
    temperature: 23.5,
    sensor: { humidity: 61 },
    state: "ready",
  }));

  assert.equal(extract("temperature"), "23.5");
  assert.equal(extract("sensor.humidity"), "61");
  assert.equal(extract("state"), "ready");
  assert.equal(extract("missing"), "");
});

test("optimized extractor preserves scalar and legacy key=value behavior", () => {
  for (const payload of ["42", "temperature=21.4, humidity=58"]) {
    const extract = createValueExtractor(payload);
    for (const key of ["$value", "temperature", "humidity", "missing"]) {
      assert.equal(extract(key), extractValue(payload, key));
    }
  }
});

test('one MQTT message reuses an object value shared by many mapped objects', (t) => {
  const payload = JSON.stringify({ sensor: { values: new Array(2000).fill(23.5) } });
  const stringify = JSON.stringify;
  let serializations = 0;
  t.mock.method(JSON, 'stringify', (value) => {
    serializations += 1;
    return stringify(value);
  });
  const extract = createValueExtractor(payload);
  const expected = stringify({ values: new Array(2000).fill(23.5) });
  for (let index = 0; index < 100; index++) assert.equal(extract(' sensor '), expected);
  assert.equal(serializations, 1, 'a repeated mapped key needs only one value serialization');
  assert.equal(extract('missing'), '');
  assert.equal(extract('sensor.values.0'), '23.5');
});
