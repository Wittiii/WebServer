const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile: nativeExecFile } = require('node:child_process');

const PROCESS_SCAN_LIMIT = 512;
const RESULT_LIMIT = 10;
const NETWORK_LIMIT = 16;
const KERNEL_MESSAGE_LIMIT = 10;
const KERNEL_PATTERN = /under.?voltage|voltage normal|thermal|throttl|out of memory|oom.kill|killed process|I\/O error|buffer I\/O|EXT4-fs error|read.only|mmc.*(?:error|timeout)|(?:eth\d|en\w+|bcmgenet).*link.*(?:down|up)/i;

function number(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cleanText(value, limit = 128) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function parseMeminfo(text) {
  const values = {};
  for (const line of String(text).split('\n')) {
    const match = /^([A-Za-z_()]+):\s*(\d+)\s*(kB)?/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  if (!Number.isFinite(values.MemTotal)) return null;
  return {
    totalBytes: values.MemTotal,
    availableBytes: values.MemAvailable ?? null,
    freeBytes: values.MemFree ?? null,
    swapTotalBytes: values.SwapTotal ?? null,
    swapFreeBytes: values.SwapFree ?? null,
    swapUsedBytes: values.SwapTotal != null && values.SwapFree != null
      ? Math.max(0, values.SwapTotal - values.SwapFree) : null,
  };
}

function parseCpuStat(text) {
  const lines = String(text).split('\n');
  const fields = /^cpu\s+(.+)/.exec(lines[0] || '')?.[1].trim().split(/\s+/).map(number);
  if (!fields || fields.length < 4 || fields.slice(0, 8).some((value) => value === null)) return null;
  // guest/guest_nice are already included in user/nice and must not be counted twice.
  return {
    total: fields.slice(0, 8).reduce((sum, value) => sum + value, 0),
    idle: fields[3],
    ioWait: fields[4] || 0,
    count: lines.filter((line) => /^cpu\d+\s/.test(line)).length,
    runnableTasks: number(/^procs_running\s+(\d+)/m.exec(String(text))?.[1]),
    blockedTasks: number(/^procs_blocked\s+(\d+)/m.exec(String(text))?.[1]),
  };
}

function cpuDelta(previous, current) {
  if (!previous || !current || current.total <= previous.total || current.idle < previous.idle) return null;
  const total = current.total - previous.total;
  const idle = Math.min(total, current.idle - previous.idle);
  // Linux documents iowait as approximate; this counter can decrease.
  const ioWait = Math.max(0, Math.min(total - idle, current.ioWait - previous.ioWait));
  return {
    usagePercent: Math.round((total - idle - ioWait) / total * 1000) / 10,
    ioWaitPercent: Math.round(ioWait / total * 1000) / 10,
    totalTicksDelta: total,
  };
}

function parsePressure(text) {
  const result = {};
  for (const line of String(text).split('\n')) {
    const match = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(line);
    if (!match) continue;
    const values = match.slice(2).map(number);
    if (values.some((value) => value === null)) continue;
    result[match[1]] = { avg10Percent: values[0], avg60Percent: values[1], avg300Percent: values[2], totalMicroseconds: values[3] };
  }
  return Object.keys(result).length ? result : null;
}

function parseThrottled(text) {
  const match = /throttled=(0x[\da-f]+)/i.exec(String(text));
  if (!match) return null;
  const mask = Number.parseInt(match[1], 16);
  if (!Number.isSafeInteger(mask) || mask > 0xffffffff) return null;
  const names = ['underVoltage', 'frequencyCapped', 'throttled', 'softTemperatureLimit'];
  const current = {};
  const occurredSinceBoot = {};
  names.forEach((name, bit) => {
    current[name] = Boolean(mask & (1 << bit));
    occurredSinceBoot[name] = Boolean(mask & (1 << (bit + 16)));
  });
  return { raw: `0x${mask.toString(16)}`, current, occurredSinceBoot };
}

function parseProcess(comm, status, stat, pid) {
  const endOfName = String(stat).lastIndexOf(')');
  if (endOfName < 0) return null;
  const fields = String(stat).slice(endOfName + 1).trim().split(/\s+/);
  const userTicks = number(fields[11]);
  const systemTicks = number(fields[12]);
  const startTimeTicks = number(fields[19]);
  if (userTicks === null || systemTicks === null || startTimeTicks === null) return null;
  const rss = /^VmRSS:\s*(\d+)\s+kB/m.exec(String(status));
  return {
    pid: Number(pid), name: cleanText(comm, 64), state: cleanText(fields[0], 1),
    rssBytes: rss ? Number(rss[1]) * 1024 : 0,
    cpuTicks: userTicks + systemTicks, startTimeTicks, cpuPercentOneCore: null,
  };
}

function failureReason(error) {
  if (/permission|not seeing messages/i.test(String(error?.stderr || ''))) return 'permission_denied';
  if (/no (?:persistent )?journal(?: files| was found)|no such boot|failed to find boot/i.test(String(error?.stderr || ''))) return 'not_available';
  if (error?.code === 'ENOENT') return 'not_available';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission_denied';
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'timeout';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  return 'read_failed';
}

async function mapLimited(items, mapper, concurrency = 4) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index]);
    }
  }));
  return output;
}

function createSystemDiagnosticsSampler({
  targetPath = process.cwd(), platform = process.platform,
  readFile = fs.readFile, readdir = fs.readdir, statfs = fs.statfs,
  execFile = nativeExecFile, osInfo = os, now = Date.now,
} = {}) {
  const absoluteTargetPath = path.resolve(targetPath);
  let previousCpu = null;
  let previousProcesses = new Map();
  let previousNetwork = new Map();
  let previousPressure = {};
  let pending = null;
  let previousBootAttempted = false;
  const seenKernelMessages = new Set();

  function execute(command, args, maxBuffer = 16384) {
    return new Promise((resolve, reject) => execFile(command, args, {
      encoding: 'utf8', timeout: 2000, maxBuffer, shell: false,
      windowsHide: true, killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })));
  }

  async function collect() {
    const sampledAt = new Date(now()).toISOString();
    const unavailable = [];
    const issues = [];
    const optional = async (source, operation) => {
      try {
        const result = await operation();
        if (result == null) unavailable.push({ source, reason: 'invalid_data' });
        return result;
      } catch (error) {
        unavailable.push({ source, reason: failureReason(error) });
        return null;
      }
    };
    let activeReads = 0;
    const readQueue = [];
    const read = async (filename) => {
      if (activeReads >= 8) await new Promise((resolve) => readQueue.push(resolve));
      else activeReads += 1;
      try { return await readFile(filename, 'utf8'); }
      finally {
        const waiting = readQueue.shift();
        if (waiting) waiting();
        else activeReads -= 1;
      }
    };
    const readKernel = async (previousBoot = false) => {
      const args = ['-k', '-b'];
      if (previousBoot) args.push('-1');
      args.push('-n', '80', '--no-pager', '-o', 'json');
      const { stdout, stderr } = await execute('journalctl', args, 131072);
      const accessRestricted = /permission|not seeing messages/i.test(stderr);
      const journalMissing = /no (?:persistent )?journal(?: files| was found)|no such boot|failed to find boot/i.test(stderr);
      if (accessRestricted || journalMissing) {
        unavailable.push({ source: previousBoot ? 'kernel.previousBoot.access' : 'kernel.access', reason: accessRestricted ? 'permission_denied' : 'not_available' });
      }
      const messages = [];
      let entriesRead = 0;
      for (const line of stdout.split('\n').slice(-81)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof entry.MESSAGE === 'string') entriesRead += 1;
        if (typeof entry.MESSAGE !== 'string' || !KERNEL_PATTERN.test(entry.MESSAGE)) continue;
        const timestampUs = number(entry.__REALTIME_TIMESTAMP);
        const key = String(entry.__CURSOR || `${timestampUs}:${entry.MESSAGE}`).slice(0, 512);
        if (!previousBoot && seenKernelMessages.has(key)) continue;
        if (!previousBoot) {
          seenKernelMessages.add(key);
          if (seenKernelMessages.size > 256) seenKernelMessages.delete(seenKernelMessages.values().next().value);
        }
        const milliseconds = timestampUs === null ? null : timestampUs / 1000;
        messages.push({ timestamp: milliseconds === null || milliseconds > 8640000000000000 ? null : new Date(milliseconds).toISOString(), message: cleanText(entry.MESSAGE, 500) });
      }
      return {
        recentMessages: messages.slice(-KERNEL_MESSAGE_LIMIT), truncated: messages.length > KERNEL_MESSAGE_LIMIT,
        windowEntries: 80, available: !journalMissing && (!accessRestricted || entriesRead > 0), accessRestricted,
      };
    };
    const cpus = osInfo.cpus();
    const portableCpu = {
      total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((total, value) => total + value, 0), 0),
      idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0), ioWait: 0, count: cpus.length,
      runnableTasks: null, blockedTasks: null,
    };
    let hostCpu = portableCpu;
    let memory = {
      totalBytes: osInfo.totalmem(), availableBytes: null, freeBytes: osInfo.freemem(),
      swapTotalBytes: null, swapFreeBytes: null, swapUsedBytes: null,
    };
    let thermal = null;
    let throttling = null;
    let pressure = null;
    let network = null;
    let processes = null;
    let kernel = null;
    const bootIdPromise = platform === 'linux' ? optional('bootId', async () => {
      const value = String(await read('/proc/sys/kernel/random/boot_id')).trim();
      return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) ? value.toLowerCase() : null;
    }) : Promise.resolve(null);
    const diskPromise = optional('disk', async () => {
      const stats = await statfs(absoluteTargetPath);
      const blockSize = number(stats.bsize);
      const blocks = number(stats.blocks);
      const available = number(stats.bavail);
      if (blockSize === null || blocks === null || available === null) return null;
      return {
        totalBytes: blocks * blockSize, freeBytes: available * blockSize,
        totalInodes: number(stats.files), freeInodes: number(stats.ffree),
      };
    });

    if (platform === 'linux') {
      const results = await Promise.all([
        optional('cpu', async () => parseCpuStat(await read('/proc/stat'))),
        optional('memory', async () => parseMeminfo(await read('/proc/meminfo'))),
        optional('thermal', async () => {
          const entries = (await readdir('/sys/class/thermal')).filter((name) => /^thermal_zone\d+$/.test(name)).slice(0, 8);
          const zones = await mapLimited(entries, async (name) => {
            const [temp, type] = await Promise.all([
              read(`/sys/class/thermal/${name}/temp`).catch(() => null),
              read(`/sys/class/thermal/${name}/type`).catch(() => ''),
            ]);
            const milliDegrees = number(temp);
            return milliDegrees !== null ? { zone: name, type: cleanText(type, 64), temperatureCelsius: milliDegrees / 1000 } : null;
          });
          const valid = zones.filter(Boolean);
          return valid.length ? valid : null;
        }),
        optional('throttling', async () => parseThrottled((await execute('vcgencmd', ['get_throttled'])).stdout)),
        (async () => {
          const values = await Promise.all(['cpu', 'memory', 'io'].map(async (source) => [source,
            await optional(`pressure.${source}`, async () => parsePressure(await read(`/proc/pressure/${source}`))),
          ]));
          return Object.fromEntries(values);
        })(),
        optional('network', async () => {
          const names = (await readdir('/sys/class/net')).filter((name) => name !== 'lo' && /^[\w.:-]+$/.test(name)).sort().slice(0, NETWORK_LIMIT);
          return mapLimited(names, async (name) => {
            const keys = [
              'operstate', 'carrier', 'statistics/rx_errors', 'statistics/tx_errors', 'statistics/rx_dropped', 'statistics/tx_dropped',
              'speed', 'duplex', 'carrier_changes', 'statistics/rx_crc_errors', 'statistics/tx_carrier_errors',
            ];
            const values = await Promise.all(keys.map((key) => read(`/sys/class/net/${name}/${key}`).catch(() => null)));
            const current = {
              name, state: values[0] === null ? null : cleanText(values[0], 16), carrier: number(values[1]),
              rxErrors: number(values[2]), txErrors: number(values[3]), rxDropped: number(values[4]), txDropped: number(values[5]),
              speedMbps: number(values[6]), duplex: values[7] === null ? null : cleanText(values[7], 16),
              carrierChanges: number(values[8]), rxCrcErrors: number(values[9]), txCarrierErrors: number(values[10]),
            };
            const previous = previousNetwork.get(name);
            const delta = {};
            for (const key of ['rxErrors', 'txErrors', 'rxDropped', 'txDropped', 'carrierChanges', 'rxCrcErrors', 'txCarrierErrors']) {
              delta[key] = previous?.[key] != null && current[key] != null && current[key] >= previous[key]
                ? current[key] - previous[key] : null;
              if (delta[key] > 0) issues.push(key === 'carrierChanges'
                ? { code: 'network_carrier_changes', interface: name, delta: delta[key] }
                : { code: 'network_counter_increased', interface: name, counter: key, delta: delta[key] });
            }
            if (previous?.carrier === 1 && current.carrier === 0) issues.push({ code: 'network_carrier_lost', interface: name });
            if (previous?.speedMbps > 0 && current.speedMbps > 0 && current.speedMbps !== previous.speedMbps) {
              issues.push({ code: 'network_speed_changed', interface: name, previousMbps: previous.speedMbps, currentMbps: current.speedMbps });
            }
            return { ...current, delta };
          });
        }),
        optional('processes', async () => {
          const allPids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
          const currentPid = String(process.pid);
          const pids = [currentPid, ...allPids.filter((pid) => pid !== currentPid)].slice(0, PROCESS_SCAN_LIMIT);
          const results = await mapLimited(pids, async (pid) => {
            try {
              const [comm, status, stat] = await Promise.all([read(`/proc/${pid}/comm`), read(`/proc/${pid}/status`), read(`/proc/${pid}/stat`)]);
              return parseProcess(comm, status, stat, pid);
            } catch { return null; } // Processes may exit or be inaccessible during a scan.
          });
          return { entries: results.filter(Boolean), scannedCount: pids.length, discoveredCount: allPids.length, truncated: allPids.length > PROCESS_SCAN_LIMIT };
        }),
        optional('kernel', async () => {
          const includePreviousBoot = !previousBootAttempted;
          previousBootAttempted = true;
          const [current, previousBoot] = await Promise.all([
            optional('kernel.currentBoot', () => readKernel()),
            includePreviousBoot ? optional('kernel.previousBoot', () => readKernel(true)) : null,
          ]);
          return { ...(current || { recentMessages: [], truncated: false, windowEntries: 80, available: false, accessRestricted: null }), previousBoot, currentBootAvailable: current?.available === true };
        }),
      ]);
      [hostCpu, memory, thermal, throttling, pressure, network, processes, kernel] = results;
    } else {
      unavailable.push({ source: 'linux_host_metrics', reason: 'unsupported_platform' });
    }

    const delta = cpuDelta(previousCpu, hostCpu);
    const cpu = hostCpu ? {
      count: hostCpu.count, usagePercent: delta?.usagePercent ?? null,
      ioWaitPercent: platform === 'linux' ? delta?.ioWaitPercent ?? null : null,
      runnableTasks: hostCpu.runnableTasks, blockedTasks: hostCpu.blockedTasks,
    } : null;
    if (processes) {
      for (const entry of processes.entries) {
        const previous = previousProcesses.get(entry.pid);
        if (delta && previous?.startTimeTicks === entry.startTimeTicks && entry.cpuTicks >= previous.cpuTicks) {
          entry.cpuPercentOneCore = Math.round((entry.cpuTicks - previous.cpuTicks) / delta.totalTicksDelta * hostCpu.count * 1000) / 10;
        }
      }
      previousProcesses = new Map(processes.entries.map((entry) => [entry.pid, entry]));
      const relevant = processes.entries.filter((entry) => /^(?:node|nodejs|ffmpeg|mediamtx)$/i.test(entry.name));
      const topRss = [...processes.entries].sort((left, right) => right.rssBytes - left.rssBytes).slice(0, RESULT_LIMIT);
      processes = {
        relevant: relevant.sort((left, right) => right.rssBytes - left.rssBytes).slice(0, RESULT_LIMIT), topRss,
        scannedCount: processes.scannedCount, discoveredCount: processes.discoveredCount,
        truncated: processes.truncated, relevantTruncated: relevant.length > RESULT_LIMIT,
      };
    }
    previousCpu = hostCpu;
    previousNetwork = new Map((network || []).map((entry) => [entry.name, entry]));
    if (pressure) {
      for (const [resource, values] of Object.entries(pressure)) {
        if (!values) continue;
        for (const [scope, stats] of Object.entries(values)) {
          const previous = previousPressure[resource]?.[scope]?.totalMicroseconds;
          stats.totalDeltaMicroseconds = previous != null && stats.totalMicroseconds >= previous ? stats.totalMicroseconds - previous : null;
          if (stats.avg10Percent > 0) issues.push({ code: 'pressure_observed', resource, scope, avg10Percent: stats.avg10Percent });
        }
      }
      previousPressure = pressure;
    }
    if (throttling) {
      for (const [flag, active] of Object.entries(throttling.current)) if (active) issues.push({ code: 'firmware_flag_current', flag });
      for (const [flag, active] of Object.entries(throttling.occurredSinceBoot)) if (active) issues.push({ code: 'firmware_flag_since_boot', flag });
    }
    if (memory?.availableBytes != null && memory.totalBytes > 0 &&
        (memory.availableBytes < 64 * 1024 ** 2 || memory.availableBytes / memory.totalBytes < 0.05)) {
      issues.push({ code: 'low_memory_available', availableBytes: memory.availableBytes, totalBytes: memory.totalBytes });
    }
    const disk = await diskPromise;
    if (disk?.totalBytes > 0 && (disk.freeBytes < 100 * 1024 ** 2 || disk.freeBytes / disk.totalBytes < 0.01)) {
      issues.push({ code: 'low_disk_space', freeBytes: disk.freeBytes, totalBytes: disk.totalBytes });
    }
    if (disk?.totalInodes > 0 && disk.freeInodes === 0) issues.push({ code: 'disk_inodes_exhausted', totalInodes: disk.totalInodes });
    if (cpu?.usagePercent >= 95) issues.push({ code: 'cpu_usage_high', usagePercent: cpu.usagePercent });
    if (cpu?.ioWaitPercent >= 20) issues.push({ code: 'io_wait_high', ioWaitPercent: cpu.ioWaitPercent, approximate: true });
    return {
      sampledAt, platform, bootId: await bootIdPromise, uptimeSeconds: Math.floor(osInfo.uptime()), loadAverage: platform === 'win32' ? null : osInfo.loadavg(),
      cpu, memory, disk, thermal, throttling, pressure, network, processes, kernel,
      issues, unavailable,
    };
  }

  return {
    sample() {
      // Timer overlap must not duplicate process scans or corrupt interval deltas.
      if (!pending) pending = collect().finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { createSystemDiagnosticsSampler, parseMeminfo, parseCpuStat, cpuDelta, parsePressure, parseThrottled, parseProcess };
