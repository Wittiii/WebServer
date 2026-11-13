const net = require("node:net");
const { WebSocketServer } = require("ws");
const { getCameraConfigById } = require("../config/cameraConfig");

const INTERCOM_WS_PATH = "/ws/camera/intercom";
const DEFAULT_INTERCOM_PORT = 3234;
const TCP_CONNECT_TIMEOUT_MS = 5000;

function isValidTargetHost(host) {
  if (!host || typeof host !== "string") return false;
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 253 || /[\s\0]/.test(trimmed)) return false;
  if (net.isIP(trimmed)) return true;
  return /^[a-zA-Z0-9.-]+$/.test(trimmed);
}

function defaultResolveCameraIp(camera) {
  const override = String(process.env.CAMERA_ESP32_P4_INTERCOM_HOST || "").trim();
  if (isValidTargetHost(override)) return override;

  const { topics } = require("../mqttBroker");
  const ipTopic = topics.get(`${camera.mqttTopicBase}/status/ip`)?.lastMessage || "";
  const ip = String(ipTopic).trim();
  if (isValidTargetHost(ip)) return ip;

  const rtspTopic = topics.get(`${camera.mqttTopicBase}/status/rtsp_url`)?.lastMessage || "";
  if (rtspTopic) {
    try {
      const parsed = new URL(String(rtspTopic).trim());
      if (isValidTargetHost(parsed.hostname)) return parsed.hostname;
    } catch {
      // Ignore malformed rtsp_url.
    }
  }
  return null;
}

function rejectUpgrade(socket, statusCode, message) {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // Ignore write error on closing socket.
  }
  socket.destroy();
}

function runSession(sessionMiddleware, req) {
  return new Promise((resolve) => {
    if (!sessionMiddleware) return resolve();
    const dummyRes = {
      getHeader: () => undefined,
      setHeader: () => undefined,
    };
    sessionMiddleware(req, dummyRes, () => resolve());
  });
}

function attachCameraIntercomWebSocket(server, options = {}) {
  const sessionMiddleware = options.sessionMiddleware;
  const getCamera = options.getCamera || getCameraConfigById;
  const resolveIp = options.resolveIp || defaultResolveCameraIp;
  const tcpConnect = options.tcpConnect || ((opts) => net.createConnection(opts));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const activeSessions = new Set();

  function closeSession(entry) {
    if (!entry) return;
    activeSessions.delete(entry);
    try {
      if (entry.tcpSocket && !entry.tcpSocket.destroyed) {
        entry.tcpSocket.destroy();
      }
    } catch {}
    try {
      if (entry.wsClient && entry.wsClient.readyState <= 1) {
        entry.wsClient.close();
      }
    } catch {}
  }

  async function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }

    if (url.pathname !== INTERCOM_WS_PATH) return;

    await runSession(sessionMiddleware, req);
    if (!req.session?.user) {
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    const cameraId = url.searchParams.get("cameraId") || "esp32-p4-cam-01";
    const camera = getCamera(cameraId, req.headers.host?.split(":")[0] || "localhost");
    if (!camera || !camera.capabilities?.intercom) {
      return rejectUpgrade(socket, 400, "Intercom Not Supported");
    }

    const targetIp = resolveIp(camera);
    if (!targetIp) {
      return rejectUpgrade(socket, 409, "Camera IP Unavailable");
    }

    const targetPort = Number(camera.capabilities.intercomPort || DEFAULT_INTERCOM_PORT);

    // Replace any stale/previous intercom session so only one speaker streams to the ESP32 at a time.
    for (const prev of [...activeSessions]) {
      closeSession(prev);
    }

    wss.handleUpgrade(req, socket, head, (wsClient) => {
      const tcpSocket = tcpConnect({ host: targetIp, port: targetPort });
      const entry = { wsClient, tcpSocket };
      activeSessions.add(entry);

      if (typeof tcpSocket.setNoDelay === "function") {
        tcpSocket.setNoDelay(true);
      }
      if (typeof tcpSocket.setTimeout === "function") {
        tcpSocket.setTimeout(TCP_CONNECT_TIMEOUT_MS);
      }

      let connected = false;

      tcpSocket.once("connect", () => {
        connected = true;
        if (typeof tcpSocket.setTimeout === "function") {
          tcpSocket.setTimeout(0);
        }
        if (wsClient.readyState === 1) {
          wsClient.send(
            JSON.stringify({
              type: "ready",
              host: targetIp,
              port: targetPort,
              sampleRate: 32000,
              channels: 1,
              format: "s16le",
            })
          );
        }
      });

      tcpSocket.once("timeout", () => {
        if (!connected && wsClient.readyState === 1) {
          wsClient.send(JSON.stringify({ type: "error", message: "TCP-Verbindung zur Kamera (Port 3234) Zeitueberschreitung" }));
        }
        closeSession(entry);
      });

      tcpSocket.on("error", (err) => {
        if (wsClient.readyState === 1) {
          wsClient.send(
            JSON.stringify({
              type: "error",
              message: `Kamera-Audio-TCP Fehler: ${err?.message || "connection_failed"}`,
            })
          );
        }
        closeSession(entry);
      });

      tcpSocket.once("close", () => {
        if (wsClient.readyState === 1) {
          wsClient.send(JSON.stringify({ type: "closed" }));
        }
        closeSession(entry);
      });

      wsClient.on("message", (data, isBinary) => {
        if (!isBinary) return;
        if (tcpSocket.destroyed || !tcpSocket.writable) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length > 0) {
          tcpSocket.write(buf);
        }
      });

      wsClient.once("close", () => closeSession(entry));
      wsClient.once("error", () => closeSession(entry));
    });
  }

  server.on("upgrade", handleUpgrade);

  return {
    closeAll() {
      server.removeListener("upgrade", handleUpgrade);
      for (const entry of [...activeSessions]) {
        closeSession(entry);
      }
      wss.close();
    },
    getActiveCount() {
      return activeSessions.size;
    },
  };
}

module.exports = {
  INTERCOM_WS_PATH,
  DEFAULT_INTERCOM_PORT,
  attachCameraIntercomWebSocket,
};
