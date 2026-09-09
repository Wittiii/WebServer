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
