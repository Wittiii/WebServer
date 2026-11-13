const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");

const { getCameraConfigs } = require("../src/config/cameraConfig");
const cameraAudioService = require("../src/services/cameraAudioService");
const { attachCameraIntercomWebSocket } = require("../src/services/cameraIntercomService");

test("Only esp32-p4-cam-01 exposes audio capabilities and separate -webrtc path", () => {
  const cameras = getCameraConfigs("localhost");
  const p4 = cameras.find((c) => c.cameraId === "esp32-p4-cam-01");
  const others = cameras.filter((c) => c.cameraId !== "esp32-p4-cam-01");

  assert.ok(p4);
  assert.equal(p4.capabilities.audio, true);
  assert.equal(p4.capabilities.audioCodec, "aac");
  assert.equal(p4.capabilities.webrtcAudioCodec, "opus");
  assert.equal(p4.capabilities.requiresTranscode, false);
  assert.equal(p4.urls.rtsp, "rtsp://localhost:8554/esp32-p4-cam-01");
  assert.equal(p4.urls.webrtcPage, "http://localhost:8889/esp32-p4-cam-01-webrtc");
  assert.equal(p4.urls.webrtcWhep, "http://localhost:8889/esp32-p4-cam-01-webrtc/whep");

  for (const cam of others) {
    assert.equal(Boolean(cam.capabilities?.audio), false);
    assert.equal(cam.urls.webrtcPage, `http://localhost:8889/${cam.streamPath}`);
  }
});

test("cameraAudioService handles audio_db threshold, cooldown, timelapse markers and 30s MP4 clip", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cam-audio-test-"));
  const prevDir = process.env.CAMERA_AUDIO_DATA_DIR;
  process.env.CAMERA_AUDIO_DATA_DIR = tmpDir;
  cameraAudioService.resetCameraAudioStateForTests();

  try {
    await cameraAudioService.updateSettings("esp32-p4-cam-01", {
      enabled: true,
      thresholdDb: -30,
      cooldownSeconds: 60,
      autoClip: true,
      clipDurationSeconds: 30,
      saveTimelapseMarkers: true,
    });

    const ffmpegCalls = [];
    const fakeRunner = async (bin, args) => {
      ffmpegCalls.push({ bin, args });
      const outPath = args[args.length - 1];
      await fs.writeFile(outPath, Buffer.from("fake-mp4-data"));
    };

    // Quiet sample -> no event
    const quiet = await cameraAudioService.ingestCameraAudioMessage(
      "camera/esp32-p4-cam-01/status/audio_db",
      "-48.5",
      { runner: fakeRunner, awaitSideEffects: true }
    );
    assert.equal(quiet, null);

    // Loud sample -> triggers threshold event + marker + clip
    const loud = await cameraAudioService.ingestCameraAudioMessage(
      "camera/esp32-p4-cam-01/status/audio_db",
      "-22.4",
      { runner: fakeRunner, awaitSideEffects: true }
    );
    assert.ok(loud);
    assert.equal(loud.type, "threshold");
    assert.equal(loud.db, -22.4);
    assert.equal(ffmpegCalls.length, 1);
    assert.ok(ffmpegCalls[0].args.includes("-c:v"));
    assert.ok(ffmpegCalls[0].args.includes("copy"));
    assert.ok(ffmpegCalls[0].args.includes("-c:a"));
    assert.ok(ffmpegCalls[0].args.includes("+faststart"));

    // Second loud sample within cooldown -> debounced
    const debounced = await cameraAudioService.ingestCameraAudioMessage(
      "camera/esp32-p4-cam-01/status/audio_db",
      "-18.0",
      { runner: fakeRunner, awaitSideEffects: true }
    );
    assert.equal(debounced, null);
    assert.equal(ffmpegCalls.length, 1);

    // Snapshot & clips verification
    const snap = await cameraAudioService.getCameraAudioSnapshot("esp32-p4-cam-01");
    assert.equal(snap.currentDb, -18.0);
    assert.equal(snap.activeAlarm, true);
    assert.equal(snap.events.length, 1);
    assert.equal(snap.markers.length, 1);

    const clips = await cameraAudioService.listAudioClips("esp32-p4-cam-01");
    assert.equal(clips.length, 1);
    assert.ok(clips[0].name.endsWith(".mp4"));

    // Path traversal guard
    const traversal = await cameraAudioService.resolveAudioClipFile("esp32-p4-cam-01", "../secret.mp4");
    assert.equal(traversal, null);

    const deleted = await cameraAudioService.deleteAudioClip("esp32-p4-cam-01", clips[0].name);
    assert.equal(deleted, true);
    assert.equal((await cameraAudioService.listAudioClips("esp32-p4-cam-01")).length, 0);
  } finally {
    cameraAudioService.resetCameraAudioStateForTests();
    if (prevDir === undefined) delete process.env.CAMERA_AUDIO_DATA_DIR;
    else process.env.CAMERA_AUDIO_DATA_DIR = prevDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("cameraIntercomService authenticates WebSocket upgrades and bridges PCM bytes to ESP32 TCP port", async () => {
  const receivedChunks = [];
  let tcpClosed = false;

  const tcpServer = net.createServer((sock) => {
    sock.on("data", (buf) => receivedChunks.push(buf));
    sock.once("close", () => {
      tcpClosed = true;
    });
  });

  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const tcpPort = tcpServer.address().port;

  let allowAuth = false;
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const intercom = attachCameraIntercomWebSocket(httpServer, {
    sessionMiddleware(req, _res, next) {
      req.session = allowAuth ? { user: { username: "admin" } } : {};
      next();
    },
    getCamera() {
      return {
        cameraId: "esp32-p4-cam-01",
        capabilities: { intercom: true, intercomPort: tcpPort },
      };
    },
    resolveIp() {
      return "127.0.0.1";
    },
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const httpPort = httpServer.address().port;

  try {
    // 1. Unauthenticated upgrade must be rejected
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/ws/camera/intercom?cameraId=esp32-p4-cam-01`);
          ws.once("open", resolve);
          ws.once("error", reject);
        })
    );

    // 2. Authenticated upgrade forwards PCM binary frames to TCP
    allowAuth = true;
    const pcmSample = Buffer.from([0x01, 0x02, 0xfe, 0xff, 0x10, 0x20]);

    const readyMsg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/ws/camera/intercom?cameraId=esp32-p4-cam-01`);
      ws.once("error", reject);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "ready") {
            ws.send(pcmSample, { binary: true }, () => {
              setTimeout(() => {
                ws.close();
                resolve(parsed);
              }, 40);
            });
          }
        }
      });
    });

    assert.equal(readyMsg.type, "ready");
    assert.equal(readyMsg.sampleRate, 32000);
    assert.equal(readyMsg.format, "s16le");
    assert.equal(readyMsg.port, tcpPort);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const combined = Buffer.concat(receivedChunks);
    assert.deepEqual(combined, pcmSample);
    assert.equal(tcpClosed, true);
  } finally {
    intercom.closeAll();
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcpServer.close(resolve));
  }
});
