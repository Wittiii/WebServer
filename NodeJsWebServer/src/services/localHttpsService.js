const { execFile } = require("node:child_process");
const { X509Certificate } = require("node:crypto");
const fsSync = require("node:fs");
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

function getCertificateExpirationInfo(certBuffer) {
  const x509 = new X509Certificate(certBuffer);
  const validToMs = new Date(x509.validTo).getTime();
  const validTo = new Date(validToMs).toISOString();
  const daysRemaining = (validToMs - Date.now()) / (86400 * 1000);
  const sanText = String(x509.subjectAltName || "");
  const subjectText = String(x509.subject || "");
  const sanMatch = sanText.match(/DNS:([a-zA-Z0-9.-]+\.ts\.net)/i);
  const cnMatch = subjectText.match(/CN=([a-zA-Z0-9.-]+\.ts\.net)/i);
  const tailscaleDomain = (sanMatch?.[1] || cnMatch?.[1] || null);
  return {
    validTo,
    daysRemaining,
    tailscaleDomain,
    subject: subjectText,
  };
}

async function tryRenewTailscaleCert({ keyPath, certPath, domain } = {}) {
  const targetDomain = String(domain || process.env.TAILSCALE_DOMAIN || "").trim();
  if (!targetDomain || !/^[a-zA-Z0-9.-]+$/.test(targetDomain)) return false;
  try {
    await execFileAsync(
      "tailscale",
      ["cert", "--cert-file", certPath, "--key-file", keyPath, targetDomain],
      { timeout: 30000 }
    );
    return true;
  } catch {
    return false;
  }
}

function startTlsAutoReload(httpsServer, options = {}) {
  const certDir = path.resolve(
    options.certDir || process.env.HTTPS_CERT_DIR || path.join(process.cwd(), "data", "tls")
  );
  const keyPath = path.resolve(
    options.keyPath || process.env.HTTPS_KEY_PATH || path.join(certDir, "server.key")
  );
  const certPath = path.resolve(
    options.certPath || process.env.HTTPS_CERT_PATH || path.join(certDir, "server.crt")
  );
  const renewThresholdDays = options.renewThresholdDays ?? 21;

  let lastKeyMtime = 0;
  let lastCertMtime = 0;
  let lastInfo = null;

  try {
    lastKeyMtime = fsSync.statSync(keyPath).mtimeMs;
    lastCertMtime = fsSync.statSync(certPath).mtimeMs;
    lastInfo = getCertificateExpirationInfo(fsSync.readFileSync(certPath));
  } catch {
    // Files may not exist yet in custom setups.
  }

  async function checkAndReload({ force = false } = {}) {
    const [keyStatBefore, certStatBefore] = await Promise.all([
      fs.stat(keyPath),
      fs.stat(certPath),
    ]);
    const initialCert = await fs.readFile(certPath);
    const info = getCertificateExpirationInfo(initialCert);

    if (info.daysRemaining <= renewThresholdDays && info.tailscaleDomain) {
      await tryRenewTailscaleCert({ keyPath, certPath, domain: info.tailscaleDomain });
    }

    const [keyStatAfter, certStatAfter] = await Promise.all([
      fs.stat(keyPath),
      fs.stat(certPath),
    ]);

    const changed =
      force ||
      keyStatAfter.mtimeMs !== lastKeyMtime ||
      certStatAfter.mtimeMs !== lastCertMtime ||
      keyStatAfter.mtimeMs !== keyStatBefore.mtimeMs ||
      certStatAfter.mtimeMs !== certStatBefore.mtimeMs;

    if (changed) {
      const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
      const nextInfo = getCertificateExpirationInfo(cert);
      httpsServer.setSecureContext({ key, cert });
      lastKeyMtime = keyStatAfter.mtimeMs;
      lastCertMtime = certStatAfter.mtimeMs;
      lastInfo = nextInfo;
      console.log(`[HTTPS] TLS-Zertifikat geladen (gueltig bis ${lastInfo.validTo})`);
      return { reloaded: true, info: lastInfo };
    }

    lastInfo = info;
    return { reloaded: false, info };
  }

  const intervalMs = options.checkIntervalMs || 6 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    checkAndReload().catch(() => {});
  }, intervalMs);
  timer.unref?.();

  return {
    checkAndReload,
    stop: () => clearInterval(timer),
    getStatus: () => lastInfo,
  };
}

module.exports = {
  isHttpsEnabled,
  resolveHttpsPort,
  collectSubjectAltNames,
  ensureLocalTlsCredentials,
  getCertificateExpirationInfo,
  tryRenewTailscaleCert,
  startTlsAutoReload,
};
