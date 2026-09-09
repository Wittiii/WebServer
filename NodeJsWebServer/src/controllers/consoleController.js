const path = require("path");
const { getLastId, listEntries, subscribe } = require("../services/runtimeLogService");
let activeStreams = 0;
const MAX_STREAMS = 10;

function getConsolePage(_req, res) {
  res.sendFile(path.join(__dirname, "..", "..", "public", "pages", "console", "console.html"));
}

function getConsoleLogs(req, res) {
  const after = Number(req.query.after || 0);
  const limit = Number(req.query.limit || 1000);
  res.json({
    ok: true,
    entries: listEntries({ after, limit }),
    lastId: getLastId(),
  });
}

function streamConsoleLogs(req, res) {
  if (activeStreams >= MAX_STREAMS) {
    return res.status(503).set('Retry-After', '15').json({ ok: false, error: 'console_connection_limit' });
  }
  const queryAfter = Number(req.query.after || 0);
  const headerAfter = Number(req.get("Last-Event-ID") || 0);
  let cursor = Math.max(0, Number.isFinite(queryAfter) ? queryAfter : 0, Number.isFinite(headerAfter) ? headerAfter : 0);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  let writable = true;
  let closed = false;
  let slowTimer;
  activeStreams += 1;

  function write(data) {
    if (closed || !writable || res.writableEnded) return;
    writable = res.write(data);
    if (!writable) {
      // Keep only the cursor, not an unbounded per-browser message queue.
      slowTimer = setTimeout(() => res.destroy(), 15000);
      slowTimer.unref();
    }
  }

  function pump() {
    if (!writable || closed) return;
    for (const entry of listEntries({ after: cursor, limit: 5000 })) {
      write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
      cursor = entry.id;
      if (!writable || closed) break;
    }
  }
  function drain() {
    clearTimeout(slowTimer);
    writable = true;
    pump();
  }
  res.on('drain', drain);
  const unsubscribe = subscribe((entry) => {
    if (!writable || closed) return;
    write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
    cursor = entry.id;
  });
  write('retry: 3000\n\n');
  pump();
  const heartbeat = setInterval(() => {
    write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();

  function cleanup() {
    if (closed) return;
    closed = true;
    activeStreams -= 1;
    clearTimeout(slowTimer);
    clearInterval(heartbeat);
    unsubscribe();
    res.removeListener('drain', drain);
  }
  res.once('close', cleanup);
  res.once('error', cleanup);
}

module.exports = { getConsoleLogs, getConsolePage, streamConsoleLogs };
