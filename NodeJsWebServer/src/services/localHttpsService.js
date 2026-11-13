const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function isHttpsEnabled() {
  return String(process.env.HTTPS_ENABLED || "false").trim().toLowerCase() === "true";
}

function resolveHttpsPort() {
  return Number(process.env.HTTPS_PORT ?? 5443);
}

function collectSubjectAltNames() {
  const entries = new Set([
    "DNS:localhost",
    "DNS:raspberrypi",
    "DNS:raspberrypi.local",
    "IP:127.0.0.1",
    "IP:::1",
  ]);

  const hostname = String(os.hostname() || "").trim();
  if (hostname && /^[a-zA-Z0-9.-]+$/.test(hostname)) {
    entries.add(`DNS:${hostname}`);
  }

  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!Array.isArray(list)) continue;
    for (const iface of list) {
      if (iface?.family === "IPv4" && iface.address) {
        entries.add(`IP:${iface.address}`);
      }
    }
  }

  const publicHost = String(process.env.MEDIA_MTX_PUBLIC_HOST || "").trim();
  if (publicHost) {
    if (net.isIP(publicHost)) {
      entries.add(`IP:${publicHost}`);
    } else if (/^[a-zA-Z0-9.-]+$/.test(publicHost)) {
      entries.add(`DNS:${publicHost}`);
    }
  }

  return Array.from(entries);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalTlsCredentials(options = {}) {
  const certDir = path.resolve(
    options.certDir || process.env.HTTPS_CERT_DIR || path.join(process.cwd(), "data", "tls")
  );
  const keyPath = path.resolve(
    options.keyPath || process.env.HTTPS_KEY_PATH || path.join(certDir, "server.key")
  );
  const certPath = path.resolve(
    options.certPath || process.env.HTTPS_CERT_PATH || path.join(certDir, "server.crt")
  );

  const [hasKey, hasCert] = await Promise.all([fileExists(keyPath), fileExists(certPath)]);
  if (hasKey && hasCert) {
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    return { key, cert, keyPath, certPath, generated: false };
  }

  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.mkdir(path.dirname(certPath), { recursive: true });

  const san = collectSubjectAltNames().join(",");
  await execFileAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "3650",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=NodeJsWebServer-Local",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { timeout: 15000 }
  );

  const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
  return { key, cert, keyPath, certPath, generated: true };
}

module.exports = {
  isHttpsEnabled,
  resolveHttpsPort,
  collectSubjectAltNames,
  ensureLocalTlsCredentials,
};
