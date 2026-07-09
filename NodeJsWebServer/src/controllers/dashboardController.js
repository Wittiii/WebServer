const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../database/db');

const execFileAsync = promisify(execFile);
const DB_FILE_PATH = path.join(__dirname, '..', 'database', 'app.db');

function readCpuSnapshot() {
  return os.cpus().map((cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idle: cpu.times.idle,
      total,
    };
  });
}

function calculateCpuUsage(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || previous.length !== current.length || previous.length === 0) {
    return 0;
  }

  let idleDiff = 0;
  let totalDiff = 0;

  for (let index = 0; index < current.length; index += 1) {
    idleDiff += Math.max(0, current[index].idle - previous[index].idle);
    totalDiff += Math.max(0, current[index].total - previous[index].total);
  }

  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

let lastCpuSnapshot = readCpuSnapshot();
let cpuUsagePercent = 0;

function refreshCpuUsage() {
  const nextSnapshot = readCpuSnapshot();
  cpuUsagePercent = calculateCpuUsage(lastCpuSnapshot, nextSnapshot);
  lastCpuSnapshot = nextSnapshot;
}

const cpuSampler = setInterval(refreshCpuUsage, 1000);
cpuSampler.unref?.();

async function getStorageStats(targetPath) {
  if (typeof fs.promises.statfs === 'function') {
    const stats = await fs.promises.statfs(targetPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const totalBytes = Number(stats.blocks || 0) * blockSize;
    const freeBytes = Number(stats.bavail ?? stats.bfree ?? 0) * blockSize;
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    };
  }

  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('df', ['-kP', targetPath]);
    const lines = String(stdout || '').trim().split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error('df output invalid');
    }

    const parts = lines[1].trim().split(/\s+/);
    const totalBytes = Number(parts[1] || 0) * 1024;
    const usedBytes = Number(parts[2] || 0) * 1024;
    const freeBytes = Number(parts[3] || 0) * 1024;

    return { totalBytes, usedBytes, freeBytes };
  }

  return {
    totalBytes: 0,
    freeBytes: 0,
    usedBytes: 0,
  };
}

const getDashboard = (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public','pages','dashboard','dashboard.html');
  res.sendFile(filePath);
};

function sanitizeWidgets(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((widget) => {
      const base = {
        id: String(widget?.id ?? '').trim(),
        type: widget?.type === 'command' ? 'command' : 'value',
        objectId: Number(widget?.objectId),
        objectName: String(widget?.objectName ?? '').trim(),
        title: String(widget?.title ?? '').trim(),
      };

      if (!base.id || !Number.isFinite(base.objectId)) return null;

      if (base.type === 'command') {
        return {
          ...base,
          commandLabel: String(widget?.commandLabel ?? '').trim(),
          commandTopic: String(widget?.commandTopic ?? '').trim(),
          commandPayload: String(widget?.commandPayload ?? ''),
        };
      }

      return {
        ...base,
        keyName: String(widget?.keyName ?? '').trim(),
        keyLabel: String(widget?.keyLabel ?? '').trim(),
        unit: String(widget?.unit ?? '').trim(),
      };
    })
    .filter(Boolean);
}

const getDashboardWidgets = (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'Nicht eingeloggt' });

  try {
    const row = db
      .prepare('SELECT widgets FROM user_dashboard_widgets WHERE username = ?')
      .get(username);

    let widgets = [];
    if (row?.widgets) {
      try {
        const parsed = JSON.parse(row.widgets);
        widgets = Array.isArray(parsed) ? parsed : [];
      } catch {
        widgets = [];
      }
    }

    res.json({ widgets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const saveDashboardWidgets = (req, res) => {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ error: 'Nicht eingeloggt' });

  const widgets = sanitizeWidgets(req.body?.widgets);
  const updatedAt = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO user_dashboard_widgets (username, widgets, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        widgets = excluded.widgets,
        updated_at = excluded.updated_at
    `).run(username, JSON.stringify(widgets), updatedAt);

    res.json({ ok: true, widgets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getDashboardSystem = async (req, res) => {
  try {
    const [dbFile, storage] = await Promise.all([
      fs.promises.stat(DB_FILE_PATH).catch(() => null),
      getStorageStats(DB_FILE_PATH).catch(() => null),
    ]);

    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);

    res.json({
      cpu: {
        usagePercent: Number(cpuUsagePercent.toFixed(1)),
        cores: os.cpus().length,
        loadAverage: os.loadavg(),
      },
      memory: {
        totalBytes: totalMemoryBytes,
        freeBytes: freeMemoryBytes,
        usedBytes: usedMemoryBytes,
      },
      storage: storage || {
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
      },
      database: {
        sizeBytes: Number(dbFile?.size || 0),
        path: DB_FILE_PATH,
      },
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getDashboard, getDashboardWidgets, saveDashboardWidgets, getDashboardSystem };
