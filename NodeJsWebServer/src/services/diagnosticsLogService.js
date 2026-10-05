const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_RECORD_BYTES = 128 * 1024;

// Only the independent collector writes these files. Serialize rotation and writes.
function createDiagnosticsLog({ directory, maxBytes = 5 * 1024 * 1024, maxFiles = 4 }) {
  const filename = path.join(directory, 'diagnostics.jsonl');
  let chain = Promise.resolve();
  let pending = 0;
  let dropped = 0;

  const archive = (index) => path.join(directory, `diagnostics.${index}.jsonl`);
  async function rotate() {
    await fs.rm(archive(maxFiles - 1), { force: true });
    for (let index = maxFiles - 2; index >= 1; index--) {
      try { await fs.rename(archive(index), archive(index + 1)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await fs.rename(filename, archive(1)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function append(record) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > Math.min(MAX_RECORD_BYTES, maxBytes)) {
      line = `${JSON.stringify({ timestamp: record.timestamp, runId: record.runId,
        event: 'record_truncated', originalEvent: record.event, bytes: Buffer.byteLength(line) })}\n`;
    }
    const size = await fs.stat(filename).then((stat) => stat.size).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return 0;
    });
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rotate();
    const handle = await fs.open(filename, 'a', 0o600);
    try {
      await handle.writeFile(line);
      // One small durable write per sample; no per-MQTT-message disk logging.
      await handle.sync();
    } finally { await handle.close(); }
  }

  return {
    write(record) {
      if (pending >= 16) { dropped++; return Promise.resolve(false); }
      pending++;
      const droppedBefore = dropped;
      dropped = 0;
      const result = chain.then(() => append(droppedBefore
        ? { ...record, droppedRecords: droppedBefore } : record)).then(() => true);
      chain = result.catch(() => {}).finally(() => { pending--; });
      return result;
    },
    flush: () => chain,
  };
}

module.exports = { createDiagnosticsLog, MAX_RECORD_BYTES };
