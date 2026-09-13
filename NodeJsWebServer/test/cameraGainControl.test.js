const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const cameraConfig = require("../src/config/cameraConfig");

// Exercise the actual HTTP controller with a fake broker. Do not open the
// application's database, connect to MQTT, or start a camera/transcoder.
function controllerWithBroker() {
  const published = [];
  const file = path.join(__dirname, "../src/controllers/cameraController.js");
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  const dependencies = {
    "../mqttBroker": {
      topics: new Map(),
      getClientSnapshot: () => ({ connected: true }),
      publish: async (topic, payload, options) => published.push({ topic, payload: JSON.parse(payload), options }),
    },
    "../config/cameraConfig": cameraConfig,
    "../services/esp32TranscodeService": { getEsp32BridgeSnapshot: () => null },
    "../services/cameraTimelapseCaptureService": { getCameraTimelapseCaptureSnapshot: () => null },
    "../services/timelapseService": {},
  };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (["fs/promises", "path", "crypto"].includes(id)) return nativeRequire(id);
      throw new Error(`Unexpected controller dependency: ${id}`);
    },
  }, { filename: file });
  return { controller: module.exports, published };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function dfrCamera() {
  return cameraConfig.getCameraConfigs("localhost").find((camera) => camera.kind === "dfr1154");
}

test("DFR gain options preserve MQTT indices with a sensor-specific default and no unsupported 128x option", () => {
  const camera = dfrCamera();
  const gain = camera.controls.fields.find((field) => field.key === "gainceiling");
  assert.deepEqual(gain.options.map((option) => option.value), [0, 1, 2, 3, 4, 5]);
  assert.match(gain.label, /OV3660/);
  assert.match(gain.options[3].label, /Standard/);
  assert.match(gain.options[5].label, /Maximum/);
  assert.equal(gain.options.some((option) => option.label.includes("128")), false);
  const infrared = camera.controls.fields.find((field) => field.key === "ir_mode");
  assert.deepEqual(infrared.options.map((option) => option.value), [0, 1, 2]);
  for (const other of cameraConfig.getCameraConfigs("localhost").filter((item) => item.kind !== "dfr1154")) {
    assert.equal(other.controls.fields.some((field) => field.label.includes("OV3660")), false);
  }
});

test("DFR setting requests publish selection indices, not OV3660 register values", async () => {
  const { controller, published } = controllerWithBroker();
  for (let index = 0; index <= 5; index++) {
    const res = response();
    await controller.sendCommand({ hostname: "localhost", body: {
      cameraId: dfrCamera().cameraId, action: "set", settings: { gainceiling: String(index) },
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(published[index].topic, `${dfrCamera().mqttTopicBase}/cmd/set`);
    assert.equal(published[index].payload.gainceiling, index);
    assert.equal(typeof published[index].payload._request_id, "string");
    assert.deepEqual(Object.keys(published[index].payload).sort(), ["_request_id", "gainceiling"]);
  }
});

test("invalid DFR gain selections and mistaken raw register values never reach MQTT", async () => {
  const { controller, published } = controllerWithBroker();
  for (const value of [-1, 6, 7, 1.5, 32, 128, 248, 512, 1023, "invalid"]) {
    const res = response();
    await controller.sendCommand({ hostname: "localhost", body: {
      cameraId: dfrCamera().cameraId, action: "set", settings: { gainceiling: value },
    } }, res);
    assert.equal(res.statusCode, 400, `must reject ${value}`);
    assert.equal(res.body.ok, false);
  }
  assert.equal(published.length, 0);
});
