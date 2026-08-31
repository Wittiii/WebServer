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
