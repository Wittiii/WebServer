const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const cameraConfig = require("../src/config/cameraConfig");

// Exercise the actual HTTP controller with a fake broker. Do not open the
// application's database, connect to MQTT, or start a camera/transcoder.
function controllerWithBroker({ captureSnapshot } = {}) {
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
    "../services/cameraTimelapseCaptureService": {
      getCameraTimelapseCaptureSnapshot: () => null,
      ...(captureSnapshot ? { captureCameraLiveSnapshot: captureSnapshot } : {}),
    },
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
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(values) { Object.assign(this.headers, values); return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
}

function dfrCamera() {
  return cameraConfig.getCameraConfigs("localhost").find((camera) => camera.kind === "dfr1154");
}

function p4Camera() {
  return cameraConfig.getCameraConfigs("localhost").find((camera) => camera.kind === "esp32-p4");
}

test("Pi reference maps platform units, preserves mounting/capture and reports offline retained values", async () => {
  const { controller, published, topics } = controllerWithBroker();
  const p4 = p4Camera();
  const source = cameraConfig.getCameraConfigs("localhost").find((camera) => camera.kind === "pi");
  const put = (base, suffix, value) => topics.set(`${base}/status/${suffix}`, {
    lastMessage: JSON.stringify(value), timestamp: Date.now(),
  });
  const pi = { width: 1920, height: 1080, framerate: 20, bitrate: 5000000,
    brightness: 0.1, contrast: 1.5, saturation: 0.5, sharpness: 1 };
  put(source.mqttTopicBase, "config", pi); put(source.mqttTopicBase, "online", false);
  put(p4.mqttTopicBase, "config", {
    width: 1920, height: 1080, server_capture_enabled: false,
    image_controls: {
      brightness: { min: -128, max: 127, step: 1, default: 0 },
      contrast: { min: 0, max: 255, step: 1, default: 128 },
      saturation: { min: 0, max: 255, step: 1, default: 128 },
      sharpness: { min: 0, max: 100, step: 1, default: 45 },
    },
    setting_controls: {
      fps: { min: 1, max: 30, step: 1 }, bitrate_bps: { min: 100000, max: 10000000, step: 1000 },
      gop: { min: 1, max: 120, step: 1 }, resolution: { min: 0, max: 2, step: 1 },
    },
  });
  let res = response();
  await controller.sendCommand({ hostname: "localhost", body: { cameraId: p4.cameraId, action: "match_pi" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, `${p4.mqttTopicBase}/cmd/set`);
  assert.deepEqual(published[0].payload, { fps: 20, bitrate_bps: 5000000, gop: 20, resolution: 0,
    brightness: 26, contrast: 192, saturation: 64, sharpness: 45, _request_id: res.body.requestId });
  assert.equal(res.body.reference.online, false);
  assert.equal(res.body.reference.approximate, true);
  assert.equal(published[0].options.qos, 1);
  assert.equal(Boolean(published[0].options.retain), false);
  for (const change of [{ width: 1280, height: 720 }, { bitrate: 50000000 }, { sharpness: 16 }]) {
    put(source.mqttTopicBase, "config", { ...pi, ...change });
    res = response();
    await controller.sendCommand({ hostname: "localhost", body: { cameraId: p4.cameraId, action: "match_pi" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(published.length, 1);
  }
  topics.delete(`${source.mqttTopicBase}/status/config`);
  res = response();
  await controller.sendCommand({ hostname: "localhost", body: { cameraId: p4.cameraId, action: "match_pi" } }, res);
  assert.equal(res.body.error, "pi_reference_unavailable");
  assert.equal(published.length, 1);
});

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
  add("frame_fps", "20.0");
  add("publisher_read_fps", "4.4");
  add("config", { image: { brightness: 12 }, image_controls: {
    brightness: { min: -128, max: 127, step: 1, value: 12 },
    contrast: { min: 0, max: 255, step: 0 },
    hflip: { min: -10, max: 10, step: 1 },
  } });
  let res = response(); controller.getOverview({ hostname: "localhost" }, res);
  let overview = res.body.cameras.find((item) => item.cameraId === camera.cameraId);
  assert.equal(overview.status.state, "streaming");
  assert.equal(overview.status.frameFps, "20.0");
  assert.equal(overview.status.publisherReadFps, "4.4");
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


test("ESP32-P4 ISP tuning controls, presets, defaults and section groups resolve and validate cleanly", async () => {
  const { controller, published, topics } = controllerWithBroker();
  const camera = p4Camera();
  topics.set(`${camera.mqttTopicBase}/status/config`, {
    lastMessage: JSON.stringify({
      image: {
        preset: 1,
        contrast: 130,
        saturation: 132,
        gamma: 65,
        sharpness: 55,
        denoise: 1,
        gain_limit: 15500,
        adaptive_image: true,
        awb: true,
        red_balance: 1000,
        blue_balance: 1000,
      },
      image_controls: {
        preset: { min: 0, max: 4, step: 1, default: 1, value: 1 },
        contrast: { min: 0, max: 255, step: 1, default: 130, value: 130 },
        saturation: { min: 0, max: 255, step: 1, default: 132, value: 132 },
        gamma: { min: 40, max: 100, step: 1, default: 65, value: 65 },
        sharpness: { min: 0, max: 100, step: 1, default: 55, value: 55 },
        denoise: { min: 0, max: 20, step: 1, default: 1, value: 1 },
        gain_limit: { min: 1000, max: 15500, step: 500, default: 15500, value: 15500 },
        adaptive_image: { min: 0, max: 1, step: 1, default: 1, value: 1 },
        awb: { min: 0, max: 1, step: 1, default: 1, value: 1 },
        red_balance: { min: 250, max: 3500, step: 1, default: 1000, value: 1000 },
        blue_balance: { min: 250, max: 3500, step: 1, default: 1000, value: 1000 },
      },
      setting_controls: {
        fps: { min: 1, max: 30, step: 1, default: 20, value: 20 },
      },
    }),
    timestamp: Date.now(),
  });

  const overviewRes = response();
  controller.getOverview({ hostname: "localhost" }, overviewRes);
  const overview = overviewRes.body.cameras.find((item) => item.cameraId === camera.cameraId);
  const fieldsByKey = new Map(overview.controls.fields.map((field) => [field.key, field]));

  assert.equal(fieldsByKey.get("preset").section, "Bild & Farbabstimmung");
  assert.deepEqual(fieldsByKey.get("preset").options.map((option) => option.value), [0, 1, 2, 3, 4]);
  assert.equal(fieldsByKey.get("preset").options[1].label, "OV5647 Standard (Pi-Abgleich als Annaeherung)");
  assert.equal(fieldsByKey.get("contrast").section, undefined);
  assert.equal(fieldsByKey.get("contrast").default, 130);
  assert.equal(fieldsByKey.get("saturation").default, 132);
  assert.equal(fieldsByKey.get("gamma").default, 65);
  assert.equal(fieldsByKey.get("sharpness").default, 55);
  assert.equal(fieldsByKey.get("denoise").default, 1);
  assert.equal(fieldsByKey.get("gain_limit").max, 15500);
  assert.equal(fieldsByKey.get("gain_limit").step, 500);
  assert.equal(fieldsByKey.get("adaptive_image").type, "checkbox");
  assert.equal(fieldsByKey.get("adaptive_image").default, 1);
  assert.equal(fieldsByKey.get("awb").section, "Weissabgleich & Ausrichtung");
  assert.equal(fieldsByKey.get("red_balance").section, undefined);
  assert.equal(fieldsByKey.get("fps").section, "Livestream");

  const validRes = response();
  const validSettings = {
    preset: "3",
    gamma: 58,
    sharpness: 52,
    denoise: 3,
    gain_limit: 8000,
    adaptive_image: false,
    awb: false,
    red_balance: 1120,
    blue_balance: 940,
  };
  await controller.sendCommand({
    hostname: "localhost",
    body: { cameraId: camera.cameraId, action: "set", settings: validSettings },
  }, validRes);
  assert.equal(validRes.statusCode, 200);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].payload, {
    ...validSettings,
    preset: 3,
    _request_id: validRes.body.requestId,
  });

  for (const invalid of [
    { preset: -1 },
    { preset: 5 },
    { preset: 1.5 },
    { gamma: 39 },
    { sharpness: 101 },
    { denoise: -1 },
    { gain_limit: 16000 },
    { gain_limit: 8250 },
    { adaptive_image: 2 },
    { awb: 2 },
    { red_balance: 200 },
    { blue_balance: 4000 },
  ]) {
    const invalidRes = response();
    await controller.sendCommand({
      hostname: "localhost",
      body: { cameraId: camera.cameraId, action: "set", settings: invalid },
    }, invalidRes);
    assert.equal(invalidRes.statusCode, 400, JSON.stringify(invalid));
  }
  assert.equal(published.length, 1);
});

test("ESP32-P4 reset command publishes QoS 1 without retain and rejects non-P4 cameras", async () => {
  const { controller, published } = controllerWithBroker();
  const camera = p4Camera();
  const pi = cameraConfig.getCameraConfigs("localhost").find((item) => item.kind === "pi");

  const imageResetRes = response();
  await controller.sendCommand({
    hostname: "localhost",
    body: { cameraId: camera.cameraId, action: "reset" },
  }, imageResetRes);
  assert.equal(imageResetRes.statusCode, 200);
  assert.equal(published[0].topic, `${camera.mqttTopicBase}/cmd/reset`);
  assert.deepEqual(published[0].payload, { _request_id: imageResetRes.body.requestId });
  assert.equal(published[0].options.qos, 1);
  assert.equal(Boolean(published[0].options.retain), false);

  const fullResetRes = response();
  await controller.sendCommand({
    hostname: "localhost",
    body: { cameraId: camera.cameraId, action: "reset", payload: "all" },
  }, fullResetRes);
  assert.equal(fullResetRes.statusCode, 200);
  assert.deepEqual(published[1].payload, { _request_id: fullResetRes.body.requestId, scope: "all" });

  const rejectedRes = response();
  await controller.sendCommand({
    hostname: "localhost",
    body: { cameraId: pi.cameraId, action: "reset" },
  }, rejectedRes);
  assert.equal(rejectedRes.statusCode, 400);
  assert.equal(published.length, 2);
});

test("Live camera snapshot endpoint streams uncached JPEG and maps inactive/busy errors to 409", async () => {
  let nextResult = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const { controller } = controllerWithBroker({
    captureSnapshot: async (camera) => nextResult(camera),
  });
  const camera = p4Camera();

  const badIdRes = response();
  await controller.getSnapshot({ hostname: "localhost", query: { cameraId: "unknown-cam" } }, badIdRes);
  assert.equal(badIdRes.statusCode, 400);

  const okRes = response();
  await controller.getSnapshot({ hostname: "localhost", query: { cameraId: camera.cameraId } }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.headers["Content-Type"], "image/jpeg");
  assert.match(okRes.headers["Cache-Control"], /no-store/);
  assert.ok(Buffer.isBuffer(okRes.body));

  for (const code of ["camera_stream_inactive", "snapshot_busy"]) {
    nextResult = () => { throw new Error(code); };
    const conflictRes = response();
    await controller.getSnapshot({ hostname: "localhost", query: { cameraId: camera.cameraId } }, conflictRes);
    assert.equal(conflictRes.statusCode, 409);
    assert.equal(conflictRes.body.error, code);
  }
});

test("ESP32-P4 resolution mode, ping command, intermediate states, and capture_request fallback work end to end", async () => {
  const { controller, published, topics } = controllerWithBroker();
  const camera = p4Camera();
  topics.set(`${camera.mqttTopicBase}/status/online`, { lastMessage: "true", timestamp: Date.now() });
  topics.set(`${camera.mqttTopicBase}/status/state`, { lastMessage: "updating", timestamp: Date.now() });
  topics.set(`${camera.mqttTopicBase}/status/stream`, {
    lastMessage: JSON.stringify({ active: false, width: 1280, height: 960, fps: 20, bitrate_bps: 4000000 }),
    timestamp: Date.now(),
  });
  topics.set(`${camera.mqttTopicBase}/status/capture_request/state`, { lastMessage: "running", timestamp: Date.now() });
  topics.set(`${camera.mqttTopicBase}/status/capture_request/enabled`, { lastMessage: "true", timestamp: Date.now() });
  topics.set(`${camera.mqttTopicBase}/status/capture_request/interval_seconds`, { lastMessage: "90", timestamp: Date.now() });
  topics.set(`${camera.mqttTopicBase}/status/config`, {
    lastMessage: JSON.stringify({
      width: 1280,
      height: 960,
      resolution: 1,
      fps: 20,
      setting_controls: {
        resolution: { min: 0, max: 2, step: 1, default: 0, value: 1 },
        fps: { min: 1, max: 30, step: 1, default: 20, value: 20 },
      },
    }),
    timestamp: Date.now(),
  });

  const overviewRes = response();
  controller.getOverview({ hostname: "localhost" }, overviewRes);
  const overview = overviewRes.body.cameras.find((item) => item.cameraId === camera.cameraId);
  assert.equal(overview.status.state, "updating");
  assert.equal(overview.timelapse.state, "running");
  assert.equal(overview.timelapse.enabled, true);
  assert.equal(overview.timelapse.intervalSeconds, 90);

  const fieldsByKey = new Map(overview.controls.fields.map((field) => [field.key, field]));
  assert.equal(fieldsByKey.get("resolution").section, "Livestream");
  assert.equal(fieldsByKey.get("fps").section, undefined);
  assert.deepEqual(fieldsByKey.get("resolution").options.map((opt) => opt.value), [0, 1, 2]);

  const setRes = response();
  await controller.sendCommand({
    hostname: "localhost",
    body: { cameraId: camera.cameraId, action: "set", settings: { resolution: "1" } },
  }, setRes);
  assert.equal(setRes.statusCode, 200);
  assert.equal(published[0].topic, `${camera.mqttTopicBase}/cmd/set`);
  assert.deepEqual(published[0].payload, { resolution: 1, _request_id: setRes.body.requestId });

  for (const bad of [{ resolution: -1 }, { resolution: 3 }, { resolution: 1.5 }]) {
    const badRes = response();
    await controller.sendCommand({
      hostname: "localhost",
      body: { cameraId: camera.cameraId, action: "set", settings: bad },
    }, badRes);
    assert.equal(badRes.statusCode, 400);
  }

  const pingRes = response();
  await controller.sendCommand({
    hostname: "localhost",
    body: { cameraId: camera.cameraId, action: "ping" },
  }, pingRes);
  assert.equal(pingRes.statusCode, 200);
  assert.equal(published[1].topic, `${camera.mqttTopicBase}/cmd/ping`);
  assert.equal(published[1].options.qos, 1);
  assert.equal(Boolean(published[1].options.retain), false);
});
