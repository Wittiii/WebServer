const { spawn } = require("node:child_process");

// Keep failed encoders from retaining unbounded diagnostic output or hanging a job.
function runMediaProcess(command, args, { timeoutMs, signal, timeoutError = "media_timeout" } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("media_cancelled"));
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let failure = null;
    let settled = false;
    const terminate = (message) => {
      failure = message;
      try { child.kill("SIGKILL"); } catch { /* close/error handles process cleanup */ }
    };
    const abort = () => terminate("media_cancelled");
    const timeout = setTimeout(() => terminate(timeoutError), timeoutMs || 30000);
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-16384);
    });
    child.once("error", (error) => finish(error));
    // close fires after stderr is drained; exit can miss the final diagnostics.
    child.once("close", (code) => {
      finish(failure || code !== 0
        ? new Error(failure || stderr.trim() || `media_failed_${code}`)
        : null);
    });
  });
}

function getMediaThreads(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(8, Math.floor(parsed)) : fallback;
}

module.exports = { getMediaThreads, runMediaProcess };
