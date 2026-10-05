const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSystemDiagnosticsSampler, parseMeminfo, parseCpuStat, cpuDelta,
  parsePressure, parseThrottled, parseProcess,
} = require('../src/services/systemDiagnosticsService');

const osInfo = {
  cpus: () => [{ times: { user: 100, nice: 0, sys: 50, idle: 700, irq: 0 } }],
  totalmem: () => 1024 ** 3, freemem: () => 128 * 1024 ** 2,
  uptime: () => 1234.9, loadavg: () => [0.3, 0.2, 0.1],
};
const disk = { bsize: 4096, blocks: 1000, bavail: 200, files: 3000, ffree: 500 };

function processStat(pid, { name = 'node', ticks = 10, start = 100, state = 'S' } = {}) {
  const fields = new Array(22).fill('0');
  fields[0] = state;
  fields[11] = String(ticks);
  fields[12] = '0';
  fields[19] = String(start);
  return `${pid} (${name}) ${fields.join(' ')}`;
}

test('Linux counters decode memory, pressure and current versus historical firmware flags', () => {
  assert.deepEqual(parseMeminfo('MemTotal: 1024 kB\nMemAvailable: 256 kB\nMemFree: 128 kB\nSwapTotal: 512 kB\nSwapFree: 32 kB\n'), {
    totalBytes: 1024 * 1024, availableBytes: 256 * 1024, freeBytes: 128 * 1024,
    swapTotalBytes: 512 * 1024, swapFreeBytes: 32 * 1024, swapUsedBytes: 480 * 1024,
  });
  assert.equal(parseMeminfo('MemFree: 123 kB'), null);
  assert.equal(parseMeminfo('MemTotal: 1024 kB').availableBytes, null);
  assert.deepEqual(parsePressure('some avg10=12.50 avg60=1.20 avg300=0.00 total=500\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=30'), {
    some: { avg10Percent: 12.5, avg60Percent: 1.2, avg300Percent: 0, totalMicroseconds: 500 },
    full: { avg10Percent: 0, avg60Percent: 0, avg300Percent: 0, totalMicroseconds: 30 },
  });
  const historical = parseThrottled('throttled=0x50000');
  assert.equal(historical.current.underVoltage, false);
  assert.equal(historical.occurredSinceBoot.underVoltage, true);
  assert.equal(historical.occurredSinceBoot.throttled, true);
  assert.equal(parseThrottled('throttled=0x80008').current.softTemperatureLimit, true);
  assert.equal(parseThrottled('permission denied'), null);
});

test('CPU deltas exclude guest double counting and distinguish approximate IO wait', () => {
  const previous = parseCpuStat('cpu 100 0 50 700 25 0 0 0 10 0\ncpu0 1 2 3 4\nprocs_running 2\nprocs_blocked 1');
  const current = parseCpuStat('cpu 160 0 70 770 75 0 0 0 20 0\ncpu0 1 2 3 4\nprocs_running 3\nprocs_blocked 0');
  assert.equal(previous.total, 875);
  assert.equal(current.runnableTasks, 3);
  assert.deepEqual(cpuDelta(previous, current), { usagePercent: 40, ioWaitPercent: 25, totalTicksDelta: 200 });
  assert.equal(cpuDelta(null, current), null);
  assert.equal(cpuDelta(current, previous), null);
  assert.equal(cpuDelta(previous, { ...current, ioWait: 20 }).ioWaitPercent, 0);
});

test('process parsing handles spaces and closing parentheses without reading argv or env', () => {
  const parsed = parseProcess('ffmpeg\n', 'VmRSS: 123 kB\n', processStat(42, { name: 'unusual ) process', ticks: 123, start: 200, state: 'D' }), 42);
  assert.deepEqual(parsed, { pid: 42, name: 'ffmpeg', state: 'D', rssBytes: 123 * 1024, cpuTicks: 123, startTimeTicks: 200, cpuPercentOneCore: null });
  assert.equal(parseProcess('node', '', 'invalid', 42), null);
});

function linuxFixture({ processCount = 2 } = {}) {
  let phase = 0;
  let activeReads = 0;
  let peakReads = 0;
  const reads = [];
  const commands = [];
  const pids = [String(process.pid), ...Array.from({ length: processCount - 1 }, (_, index) => String(100000 + index))];
  const kernelLine = JSON.stringify({ __CURSOR: 'current-oom', __REALTIME_TIMESTAMP: '1700000000000000', MESSAGE: 'Out of memory: Killed process 42 (ffmpeg)' });
  const readFile = async (filename) => {
    reads.push(filename);
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (filename === '/proc/stat') return `cpu ${phase ? '160 0 70 770 75' : '100 0 50 700 25'} 0 0 0 20 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\ncpu2 1 2 3 4\ncpu3 1 2 3 4\nprocs_running 2\nprocs_blocked 1`;
      if (filename === '/proc/meminfo') return 'MemTotal: 1048576 kB\nMemAvailable: 131072 kB\nMemFree: 65536 kB\nSwapTotal: 262144 kB\nSwapFree: 65536 kB';
      if (filename === '/proc/sys/kernel/random/boot_id') return '01234567-89ab-cdef-0123-456789abcdef\n';
      if (/\/pressure\//.test(filename)) return `some avg10=1.20 avg60=0.30 avg300=0.10 total=${phase ? 600 : 500}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0`;
      if (filename.endsWith('/thermal_zone0/temp')) return '62000\n';
      if (filename.endsWith('/thermal_zone0/type')) return 'cpu-thermal\n';
      if (filename.startsWith('/sys/class/net/')) {
        if (filename.endsWith('/operstate')) return filename.includes('/wlan0/') ? 'down\n' : phase ? 'down\n' : 'up\n';
        if (filename.endsWith('/carrier')) return filename.includes('/wlan0/') || phase ? '0\n' : '1\n';
        if (filename.endsWith('/rx_errors')) return phase ? '3\n' : '1\n';
        return '0\n';
      }
      const processMatch = /^\/proc\/(\d+)\/(comm|status|stat)$/.exec(filename);
      if (processMatch) {
        const pid = Number(processMatch[1]);
        if (processMatch[2] === 'comm') return pid === process.pid ? 'node\n' : 'ffmpeg\n';
        if (processMatch[2] === 'status') return `VmRSS: ${pid === process.pid ? 3000 : pid} kB\n`;
        return processStat(pid, { ticks: phase ? 30 : 10 });
      }
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    } finally { activeReads -= 1; }
  };
  const readdir = async (directory) => {
    if (directory === '/proc') return [...pids, 'self', 'net'];
    if (directory === '/sys/class/net') return ['lo', 'eth0', 'wlan0'];
    if (directory === '/sys/class/thermal') return ['thermal_zone0', 'cooling_device0'];
    throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
  };
  const execFile = (command, args, options, callback) => {
    commands.push({ command, args, options });
    const stdout = command === 'vcgencmd' ? 'throttled=0x50005\n'
      : args.includes('-1') ? JSON.stringify({ __CURSOR: 'previous-sd', __REALTIME_TIMESTAMP: '1699999999000000', MESSAGE: 'mmc0: timeout waiting for hardware interrupt' }) + '\n'
        : `${kernelLine}\n${JSON.stringify({ MESSAGE: 'unrelated startup information' })}\n`;
    queueMicrotask(() => callback(null, stdout, ''));
  };
  const sampler = createSystemDiagnosticsSampler({ targetPath: '.', platform: 'linux', readFile, readdir, statfs: async () => disk, execFile, osInfo, now: () => 1700000000000 + phase * 60000 });
  return { sampler, reads, commands, setPhase: (value) => { phase = value; }, peakReads: () => peakReads };
}

test('sampler preserves facts, calculates bounded interval deltas and deduplicates kernel events', async () => {
  const fixture = linuxFixture();
  const firstPromise = fixture.sampler.sample();
  assert.equal(firstPromise, fixture.sampler.sample(), 'overlapping calls share one collection');
  const first = await firstPromise;
  assert.equal(first.cpu.usagePercent, null);
  assert.equal(first.bootId, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(first.memory.availableBytes, 128 * 1024 ** 2);
  assert.equal(first.memory.swapUsedBytes, 192 * 1024 ** 2);
  assert.equal(first.disk.freeBytes, 200 * 4096);
  assert.equal(first.disk.freeInodes, 500);
  assert.equal(first.thermal[0].temperatureCelsius, 62);
  assert.equal(first.network.length, 2);
  assert.equal(first.network[1].state, 'down', 'down interfaces are retained as link evidence');
  assert.equal(first.kernel.recentMessages.length, 1);
  assert.equal(first.kernel.previousBoot.recentMessages.length, 1);
  assert.ok(first.issues.some((issue) => issue.code === 'firmware_flag_current' && issue.flag === 'underVoltage'));
  assert.equal(first.issues.some((issue) => issue.code === 'network_carrier_lost'), false);
  fixture.setPhase(1);
  const second = await fixture.sampler.sample();
  assert.equal(second.cpu.usagePercent, 40);
  assert.equal(second.cpu.ioWaitPercent, 25);
  assert.equal(second.processes.relevant.find((entry) => entry.pid === process.pid).cpuPercentOneCore, 40);
  assert.equal(second.pressure.memory.some.totalDeltaMicroseconds, 100);
  assert.equal(second.network[0].delta.rxErrors, 2);
  assert.ok(second.issues.some((issue) => issue.code === 'network_carrier_lost' && issue.interface === 'eth0'));
  assert.equal(second.kernel.recentMessages.length, 0);
  assert.equal(second.kernel.previousBoot, null);
  assert.equal(fixture.commands.filter((entry) => entry.args.includes('-1')).length, 1);
  assert.ok(fixture.peakReads() <= 8);
  assert.equal(fixture.reads.some((filename) => /cmdline|environ|\.env|\.db/.test(filename)), false);
  for (const command of fixture.commands) {
    assert.equal(command.options.shell, false);
    assert.equal(command.options.timeout, 2000);
    assert.equal(command.options.killSignal, 'SIGKILL');
    assert.equal(command.options.windowsHide, true);
    assert.ok(command.options.maxBuffer <= 131072);
  }
});

test('large process lists are bounded and explicitly marked as truncated', async () => {
  const fixture = linuxFixture({ processCount: 600 });
  const sample = await fixture.sampler.sample();
  assert.equal(sample.processes.scannedCount, 512);
  assert.equal(sample.processes.discoveredCount, 600);
  assert.equal(sample.processes.truncated, true);
  assert.equal(sample.processes.topRss.length, 10);
  assert.equal(sample.processes.relevant.length, 10);
  assert.equal(sample.processes.relevantTruncated, true);
  assert.ok(fixture.peakReads() <= 8);
  assert.ok(fixture.reads.filter((filename) => /^\/proc\/\d+\//.test(filename)).length <= 512 * 3);
});

test('Linux optional data failures are explicit and never expose command stderr', async () => {
  const missing = async () => { throw Object.assign(new Error('private error details'), { code: 'ENOENT' }); };
  const sampler = createSystemDiagnosticsSampler({
    platform: 'linux', readFile: missing, readdir: missing, statfs: missing, osInfo,
    execFile: (_command, _args, _options, callback) => callback(Object.assign(new Error('private token'), { code: 'EPERM', stderr: 'secret output' })),
  });
  const sample = await sampler.sample();
  assert.equal(sample.cpu, null);
  assert.equal(sample.memory, null);
  assert.equal(sample.disk, null);
  assert.equal(sample.throttling, null);
  assert.equal(sample.kernel.currentBootAvailable, false);
  assert.ok(sample.unavailable.some((entry) => entry.source === 'throttling' && entry.reason === 'permission_denied'));
  assert.ok(sample.unavailable.some((entry) => entry.source === 'kernel.previousBoot'));
  assert.equal(JSON.stringify(sample).includes('secret'), false);
  assert.equal(JSON.stringify(sample).includes('private'), false);
});

test('non-Linux uses portable metrics and never executes Linux helpers', async () => {
  const forbidden = () => { throw new Error('Linux helper invoked'); };
  const sampler = createSystemDiagnosticsSampler({ platform: 'win32', osInfo, statfs: async () => disk, readFile: forbidden, readdir: forbidden, execFile: forbidden });
  const sample = await sampler.sample();
  assert.equal(sample.uptimeSeconds, 1234);
  assert.equal(sample.bootId, null);
  assert.equal(sample.loadAverage, null);
  assert.equal(sample.memory.totalBytes, 1024 ** 3);
  assert.equal(sample.memory.availableBytes, null);
  assert.equal(sample.pressure, null);
  assert.equal(sample.network, null);
  assert.equal(sample.processes, null);
  assert.ok(sample.unavailable.some((entry) => entry.reason === 'unsupported_platform'));
});

test('journal permission hints and missing previous boot are availability facts rather than healthy empty history', async () => {
  const missing = async () => { throw Object.assign(new Error('unavailable'), { code: 'ENOENT' }); };
  const sampler = createSystemDiagnosticsSampler({
    platform: 'linux', readFile: missing, readdir: missing, statfs: async () => disk, osInfo,
    execFile: (command, args, _options, callback) => {
      if (command === 'vcgencmd') return callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      if (args.includes('-1')) return callback(Object.assign(new Error('no previous boot'), {
        code: 1, stderr: 'Specifying boot ID or boot offset has no effect, no persistent journal was found.',
      }));
      callback(null, '', 'Hint: You are currently not seeing messages from other users and the system.');
    },
  });
  const sample = await sampler.sample();
  assert.equal(sample.kernel.currentBootAvailable, false);
  assert.equal(sample.kernel.available, false);
  assert.equal(sample.kernel.accessRestricted, true);
  assert.equal(sample.kernel.previousBoot, null);
  assert.deepEqual(sample.unavailable.filter((entry) => entry.source.startsWith('kernel')), [
    { source: 'kernel.access', reason: 'permission_denied' },
    { source: 'kernel.previousBoot', reason: 'not_available' },
  ]);
});

test('resource threshold flags include measured values and inode exhaustion needs an inode-capable filesystem', async () => {
  let inodeCount = 100;
  const sampler = createSystemDiagnosticsSampler({
    platform: 'linux', osInfo,
    readdir: async () => [],
    readFile: async (filename) => {
      if (filename === '/proc/meminfo') return 'MemTotal: 1048576 kB\nMemAvailable: 100 kB';
      throw Object.assign(new Error('not available'), { code: 'ENOENT' });
    },
    statfs: async () => ({ bsize: 4096, blocks: 1000000, bavail: 0, files: inodeCount, ffree: 0 }),
    execFile: (_command, _args, _options, callback) => callback(Object.assign(new Error('missing'), { code: 'ENOENT' })),
  });
  const first = await sampler.sample();
  assert.ok(first.issues.some((issue) => issue.code === 'low_memory_available' && issue.availableBytes === 100 * 1024));
  assert.ok(first.issues.some((issue) => issue.code === 'low_disk_space' && issue.freeBytes === 0));
  assert.ok(first.issues.some((issue) => issue.code === 'disk_inodes_exhausted'));
  inodeCount = 0;
  const second = await sampler.sample();
  assert.equal(second.issues.some((issue) => issue.code === 'disk_inodes_exhausted'), false);
});
