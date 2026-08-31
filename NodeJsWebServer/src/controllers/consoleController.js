const path = require("path");
const { getLastId, listEntries, subscribe } = require("../services/runtimeLogService");

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
  const queryAfter = Number(req.query.after || 0);
  const headerAfter = Number(req.get("Last-Event-ID") || 0);
  const after = Math.max(0, queryAfter, headerAfter);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  let writable = true;

  function send(entry) {
    if (!writable || res.writableEnded) return;
    writable = res.write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
    if (!writable) {
      res.once("drain", () => {
        writable = true;
      });
    }
  }

  for (const entry of listEntries({ after, limit: 5000 })) send(entry);
  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => {
    if (writable && !res.writableEnded) res.write(": heartbeat\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

module.exports = { getConsoleLogs, getConsolePage, streamConsoleLogs };
