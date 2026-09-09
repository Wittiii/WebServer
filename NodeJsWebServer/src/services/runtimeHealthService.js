const { monitorEventLoopDelay } = require('node:perf_hooks');

function startRuntimeHealthMonitor() {
  const histogram = monitorEventLoopDelay({ resolution: 50 });
  histogram.enable();
  let delay = { maxMs: 0, p99Ms: 0 };
  let lastWarningAt = 0;
  const timer = setInterval(() => {
    delay = { maxMs: Math.round(histogram.max / 1e6), p99Ms: Math.round(histogram.percentile(99) / 1e6) };
    histogram.reset();
    if (delay.maxMs > 500 && Date.now() - lastWarningAt >= 60000) {
      lastWarningAt = Date.now();
      console.warn(`[Runtime] Event loop paused ${delay.maxMs} ms; RSS ${Math.round(process.memoryUsage().rss / 1048576)} MiB`);
    }
  }, 5000);
  timer.unref();
  return {
    snapshot: () => ({ ok: true, uptimeSeconds: Math.floor(process.uptime()), memoryBytes: process.memoryUsage(), eventLoop: delay }),
    stop: () => { clearInterval(timer); histogram.disable(); },
  };
}

module.exports = { startRuntimeHealthMonitor };
