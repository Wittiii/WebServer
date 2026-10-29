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
  const topics = new Map();
  const file = path.join(__dirname, "../src/controllers/cameraController.js");
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  const dependencies = {
    "../mqttBroker": {
      topics,
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
  return { controller: module.exports, published, topics };
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

function p4Camera() {
  return cameraConfig.getCameraConfigs("localhost").find((camera) => camera.kind === "esp32-p4");
}

test("ESP32-P4 is a direct H264 MediaMTX camera without an FFmpeg bridge", () => {
  const camera = p4Camera();
  assert.ok(camera);
  assert.equal(camera.cameraId, "esp32-p4-cam-01");
  assert.equal(camera.mqttTopicBase, "camera/esp32-p4-cam-01");
  assert.equal(camera.streamPath, "esp32-p4-cam-01");
  assert.equal(camera.capabilities.h264, true);
  assert.equal(camera.capabilities.requiresTranscode, false);
  assert.equal(camera.requiresCommandAck, true);
  assert.equal(camera.urls.webrtcPage, "http://localhost:8889/esp32-p4-cam-01");
  assert.equal(camera.urls.rtsp, "rtsp://localhost:8554/esp32-p4-cam-01");
});

test("ESP32-P4 settings are validated and sent QoS 1 without retain", async () => {
  const { controller, published, topics } = controllerWithBroker();
  const camera = p4Camera();
  topics.set(`${camera.mqttTopicBase}/status/config`, { lastMessage: JSON.stringify({
    image: { brightness: 0, contrast: 128, hflip: 0 },
    image_controls: {
      brightness: { min: -128, max: 127, step: 1, value: 0 },
      contrast: { min: 0, max: 255, step: 1, value: 128 },
      hflip: { min: 0, max: 1, step: 1, value: 0 },
    },
    setting_controls: {
      server_capture_enabled: { min: 0, max: 1, step: 1, value: 1 },
      server_capture_interval_seconds: { min: 10, max: 86400, step: 1, value: 60 },
      fps: { min: 1, max: 30, step: 1, value: 20 },
      bitrate_bps: { min: 100000, max: 10000000, step: 1000, value: 4000000 },
      gop: { min: 1, max: 120, step: 1, value: 20 },
    },
  }), timestamp: Date.now() });
  const res = response();
  const settings = { brightness: 10, contrast: 130, hflip: true,
    server_capture_enabled: false, server_capture_interval_seconds: 120, fps: 15, bitrate_bps: 2500000, gop: 15 };
  await controller.sendCommand({ hostname: "localhost", body: {
    cameraId: camera.cameraId, action: "set", settings,
  } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "camera/esp32-p4-cam-01/cmd/set");
  assert.deepEqual(published[0].payload, { ...settings, _request_id: res.body.requestId });
  assert.equal(published[0].options.qos, 1);
  assert.equal(Boolean(published[0].options.retain), false);

  for (const invalid of [
    { width: 1280 }, { height: 720 }, { fps: 31 }, { bitrate_bps: 2500500 },
    { gop: 0 }, { rtsp_path: "live" }, { brightness: 128 }, { contrast: -1 },
    { server_capture_enabled: 2 }, { server_capture_interval_seconds: 9 }, { server_capture_interval_seconds: 10.5 },
    { saturation: 128 }, { brightness: 0.5 }, { brightness: null }, { contrast: true },
  ]) {
    const invalidResponse = response();
    await controller.sendCommand({ hostname: "localhost", body: {
      cameraId: camera.cameraId, action: "set", settings: invalid,
    } }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 400);
  }
  assert.equal(published.length, 1);
});

test("P4 stream JSON drives streaming state, image controls and reported values", () => {
  const { controller, topics } = controllerWithBroker();
  const camera = p4Camera();
  const add = (suffix, value) => topics.set(`${camera.mqttTopicBase}/status/${suffix}`, {
    lastMessage: typeof value === "string" ? value : JSON.stringify(value), timestamp: Date.now(),
  });
  add("online", "true");
  add("stream", { active: true, codec: "h264", transport: "rtsp-publisher" });
  add("config", { image: { brightness: 12 }, image_controls: {
    brightness: { min: -128, max: 127, step: 1, value: 12 },
    contrast: { min: 0, max: 255, step: 0 },
    hflip: { min: -10, max: 10, step: 1 },
  } });
  let res = response(); controller.getOverview({ hostname: "localhost" }, res);
  let overview = res.body.cameras.find((item) => item.cameraId === camera.cameraId);
  assert.equal(overview.status.state, "streaming");
  assert.equal(res.body.summary.streaming, 1);
  assert.equal(overview.requiresCommandAck, true);
  assert.equal(overview.stream.currentConfig.brightness, 12);
  assert.equal(overview.controls.fields.length, 1);
  assert.equal(overview.controls.fields[0].key, "brightness");
  add("stream", { active: false });
  res = response(); controller.getOverview({ hostname: "localhost" }, res);
  assert.equal(res.body.summary.streaming, 0);
  add("online", "false"); add("stream", { active: true });
  res = response(); controller.getOverview({ hostname: "localhost" }, res);
  overview = res.body.cameras.find((item) => item.cameraId === camera.cameraId);
  assert.equal(overview.status.state, "offline");
  assert.equal(res.body.summary.streaming, 0);
});

test("ESP32-P4 command acknowledgement is read safely from its correlated status topic", () => {
  const { controller, topics } = controllerWithBroker();
  const camera = p4Camera();
  const base = camera.mqttTopicBase;
  const add = (suffix, value, timestamp) => topics.set(`${base}/status/${suffix}`, { lastMessage: value, timestamp });
  add("online", "false", 1);
  add("stream", '{"active":true,"codec":"h264","fps":20}', 2);
  add("config", "not-json", 3);
  add("command/request-123", '{"ok":true,"command":"set","applied":{"fps":20}}', 4);

  const res = response();
  controller.getOverview({ hostname: "localhost" }, res);
  const overview = res.body.cameras.find((item) => item.cameraId === camera.cameraId);
  assert.equal(overview.status.online, false);
  assert.equal(overview.stream.currentConfig.fps, 20);
  assert.equal(overview.status.lastCommand.id, "request-123");
  assert.equal(overview.status.lastCommand.name, "set");
  assert.equal(overview.status.lastCommand.result, "ok");
});

test("Pi settings publish only camera fields and request metadata without retain", async () => {
  const { controller, published } = controllerWithBroker();
  const camera = cameraConfig.getCameraConfigs("localhost").find((item) => item.kind === "pi");
  const settings = { width: 1280, height: 720, framerate: 15, bitrate: 2500000,
    sharpness: 1, brightness: 0, contrast: 1, saturation: 1,
    server_capture_enabled: true, server_capture_interval_seconds: 60 };
  const res = response();
  await controller.sendCommand({ hostname: "localhost", body: {
    cameraId: camera.cameraId, action: "set", settings,
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, `${camera.mqttTopicBase}/cmd/set`);
  assert.deepEqual(published[0].payload, { ...settings, _request_id: res.body.requestId });
  assert.equal(published[0].options.qos, 1);
  assert.equal(Boolean(published[0].options.retain), false);
});

test("invalid or forbidden Pi settings are rejected before any MQTT publish", async () => {
  const { controller, published } = controllerWithBroker();
  const camera = cameraConfig.getCameraConfigs("localhost").find((item) => item.kind === "pi");
  for (const settings of [
    { width: 1279 }, { height: 5000 }, { framerate: 2.5 }, { framerate: 61 },
    { bitrate: 50000001 }, { bitrate: 12345.5 }, { brightness: 2 }, { contrast: -1 },
    { saturation: 33 }, { sharpness: 17 }, { brightness: null }, { contrast: true },
    { contrast: [] }, { brightness: "" }, { server_capture_interval_seconds: 10.5 },
    { ffmpeg_path: "/tmp/program", framerate: 10 }, { host: "other-host" },
  ]) {
    const res = response();
    await controller.sendCommand({ hostname: "localhost", body: {
      cameraId: camera.cameraId, action: "set", settings,
    } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(settings));
  }
  assert.equal(published.length, 0);
});

test("Pi stream commands keep their existing topic and non-retained delivery", async () => {
  const { controller, published } = controllerWithBroker();
  const camera = cameraConfig.getCameraConfigs("localhost").find((item) => item.kind === "pi");
  for (const action of ["start", "stop", "restart", "ping"]) {
    const res = response();
    await controller.sendCommand({ hostname: "localhost", body: { cameraId: camera.cameraId, action } }, res);
    assert.equal(res.statusCode, 200);
    const message = published.at(-1);
    assert.equal(message.topic, `${camera.mqttTopicBase}/cmd/${action}`);
    assert.equal(Boolean(message.options.retain), false);
  }
});

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
