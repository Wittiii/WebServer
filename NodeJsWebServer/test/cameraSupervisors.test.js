const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");

async function loadService(name, overrides, context = {}) {
  const file = path.join(__dirname, "../src/services", name);
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, "utf8"), {
    module, exports: module.exports, AbortController, URL, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    process: { env: {}, cwd: () => process.cwd() },
    require: (id) => overrides[id] || nativeRequire(id),
    ...context,
  }, { filename: file });
  return module.exports;
}

test("capture interval defaults to 60 seconds, and shutdown prevents a spawn after pending storage work", async () => {
  const camera = { cameraId: "fake", kind: "pi", mqttTopicBase: "camera/fake", streamPath: "fake", archive: { type: "server_capture" } };
  const topics = new Map([
    ["camera/fake/status/online", { lastMessage: "true" }],
    ["camera/fake/status/state", { lastMessage: "streaming" }],
  ]);
  let finishScan;
  let spawned = 0;
  const scanning = new Promise((resolve) => { finishScan = resolve; });
  const service = await loadService("cameraTimelapseCaptureService.js", {
    "../config/cameraConfig": { getCameraConfigs: () => [camera] },
    "../mqttBroker": { topics, publish: async () => {} },
    "./esp32TranscodeService": { getEsp32BridgeSnapshot: () => null },
    "./timelapseService": { listTimelapseFiles: () => scanning },
    "./mediaProcessService": { getMediaThreads: () => 1, runMediaProcess: () => { spawned += 1; } },
    "fs/promises": { statfs: async () => ({ bavail: 10 ** 9, bsize: 4096 }) },
  }, { setInterval: () => 1, clearInterval() {} });
  service.startCameraTimelapseCaptureSupervisor();
  assert.equal(service.getCameraTimelapseCaptureSnapshot("fake").intervalSeconds, 60);
  const stopping = service.stopCameraTimelapseCaptureSupervisor();
  finishScan({ totalBytes: 0, latestImage: null });
  await stopping;
  assert.equal(spawned, 0);
});

test("unchanged ffmpeg progress reports do not keep a stalled camera bridge alive", async () => {
  let now = 100000;
  let tick;
  let child;
  const camera = { cameraId: "fake", kind: "esp32", mqttTopicBase: "camera/fake", streamPath: "fake" };
  const topics = new Map([
    ["camera/fake/status/online", { lastMessage: "true" }],
    ["camera/fake/status/rtsp_url", { lastMessage: "rtsp://fake.invalid/stream" }],
  ]);
  const service = await loadService("esp32TranscodeService.js", {
    "../config/cameraConfig": { getCameraConfigs: () => [camera] },
    "../mqttBroker": { topics, publish: async () => {} },
    child_process: {
      spawn() {
        child = new EventEmitter();
        child.pid = 123;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
          queueMicrotask(() => { child.emit("exit", null, signal); child.emit("close", null, signal); });
          return true;
        };
        return child;
      },
    },
  }, {
    Date: class extends Date { static now() { return now; } },
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval() {},
  });
  service.startEsp32TranscodeSupervisor();
  child.stdout.emit("data", "frame=1\nout_time_us=1000\nprogress=continue\n");
  assert.equal(service.getEsp32BridgeSnapshot("fake").state, "running");
  now += 26000;
  child.stdout.emit("data", "frame=1\nout_time_us=1000\nprogress=continue\n");
  tick();
  assert.equal(service.getEsp32BridgeSnapshot("fake").state, "stopping");
  assert.equal(service.getEsp32BridgeSnapshot("fake").lastError, "ffmpeg progress stalled");
  await service.stopEsp32TranscodeSupervisor();
  assert.equal(service.getEsp32BridgeSnapshot("fake").pid, null);
});

test("camera status URLs containing a NUL cannot reach child-process arguments", async () => {
  let spawned = 0;
  const camera = { cameraId: "fake", kind: "esp32", mqttTopicBase: "camera/fake", streamPath: "fake" };
  const service = await loadService("esp32TranscodeService.js", {
    "../config/cameraConfig": { getCameraConfigs: () => [camera] },
    "../mqttBroker": { publish: async () => {}, topics: new Map([
      ["camera/fake/status/online", { lastMessage: "true" }],
      ["camera/fake/status/rtsp_url", { lastMessage: "rtsp://camera.invalid/stream\u0000" }],
    ]) },
    child_process: { spawn() { spawned += 1; throw new Error("must_not_spawn"); } },
  }, { setInterval: () => 1, clearInterval() {} });
  service.startEsp32TranscodeSupervisor();
  assert.equal(spawned, 0);
  assert.equal(service.getEsp32BridgeSnapshot("fake").lastError, "invalid_rtsp_source_url");
  await service.stopEsp32TranscodeSupervisor();
});

test("a synchronous encoder spawn failure becomes a camera error with delayed retry", async () => {
  let now = 100000;
  let tick;
  let attempts = 0;
  const camera = { cameraId: "fake", kind: "esp32", mqttTopicBase: "camera/fake", streamPath: "fake" };
  const service = await loadService("esp32TranscodeService.js", {
    "../config/cameraConfig": { getCameraConfigs: () => [camera] },
    "../mqttBroker": { publish: async () => {}, topics: new Map([
      ["camera/fake/status/online", { lastMessage: "true" }],
      ["camera/fake/status/rtsp_url", { lastMessage: "rtsp://camera.invalid/stream" }],
    ]) },
    child_process: { spawn() { attempts += 1; throw new Error("spawn_rejected"); } },
  }, {
    Date: class extends Date { static now() { return now; } },
    setInterval: (callback) => { tick = callback; return 1; }, clearInterval() {},
  });
  service.startEsp32TranscodeSupervisor();
  assert.equal(service.getEsp32BridgeSnapshot("fake").state, "error");
  assert.equal(service.getEsp32BridgeSnapshot("fake").lastError, "spawn_rejected");
  assert.equal(service.getEsp32BridgeSnapshot("fake").pid, null);
  tick();
  assert.equal(attempts, 1);
  now += 6000;
  tick();
  assert.equal(attempts, 2);
  await service.stopEsp32TranscodeSupervisor();
});

test("bridge error floods retain a bounded recent message and limit console writes", async () => {
  let now = 100000;
  let child;
  const logs = [];
  const camera = { cameraId: "fake", kind: "esp32", mqttTopicBase: "camera/fake", streamPath: "fake" };
  const service = await loadService("esp32TranscodeService.js", {
    "../config/cameraConfig": { getCameraConfigs: () => [camera] },
    "../mqttBroker": { publish: async () => {}, topics: new Map([
      ["camera/fake/status/online", { lastMessage: "true" }],
      ["camera/fake/status/rtsp_url", { lastMessage: "rtsp://camera.invalid/stream" }],
    ]) },
    child_process: { spawn() {
      child = new EventEmitter();
      child.pid = 123;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        queueMicrotask(() => { child.emit("exit", null, signal); child.emit("close", null, signal); });
        return true;
      };
      return child;
    } },
  }, {
    Date: class extends Date { static now() { return now; } },
    console: { log: (message) => logs.push(message), warn() {}, error() {} },
    setInterval: () => 1, clearInterval() {},
  });
  service.startEsp32TranscodeSupervisor();
  const initialWrites = logs.length;
  child.stderr.emit("data", `invalid ${"x".repeat(100000)}FINAL_ERROR`);
  assert.ok(service.getEsp32BridgeSnapshot("fake").lastMessage.length <= 1024);
  assert.ok(service.getEsp32BridgeSnapshot("fake").lastError.length <= 1024);
  assert.ok(service.getEsp32BridgeSnapshot("fake").lastError.endsWith("FINAL_ERROR"));
  assert.ok(logs.at(-1).length < 1200);
  for (let index = 0; index < 20; index += 1) child.stderr.emit("data", `encoder failed ${index}`);
  assert.equal(logs.length - initialWrites, 1);
  assert.equal(service.getEsp32BridgeSnapshot("fake").lastError, "encoder failed 19");
  now += 5001;
  child.stderr.emit("data", "encoder failed again");
  assert.equal(logs.length - initialWrites, 2);
  assert.match(logs.at(-1), /20/);
  // Child-process exit precedes stream closure; final diagnostics can arrive in
  // between and must remain associated with this encoder.
  child.emit("exit", 2, null);
  assert.equal(service.getEsp32BridgeSnapshot("fake").pid, 123);
  child.stderr.emit("data", "late stderr error");
  child.emit("close", 2, null);
  assert.equal(service.getEsp32BridgeSnapshot("fake").pid, null);
  assert.equal(service.getEsp32BridgeSnapshot("fake").lastError, "late stderr error");
  assert.match(logs.at(-1), /late stderr error/);
  await service.stopEsp32TranscodeSupervisor();
});
