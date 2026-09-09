// Spread an existing retention policy over incoming messages instead of deleting
// an entire backlog synchronously during the first sensor message after startup.
function createRetentionCleanup(deleteBatch, { batchSize = 500, retryMs = 1000, intervalMs = 86400000 } = {}) {
  let nextRunAt = 0;
  let lastNow = 0;
  return (now, cutoff) => {
    const clockMovedBack = now < lastNow;
    lastNow = now;
    if (!clockMovedBack && now < nextRunAt) return;
    const { changes } = deleteBatch.run(cutoff, batchSize);
    // Update only after success so a transient busy/disk error can be retried.
    nextRunAt = now + (changes >= batchSize ? retryMs : intervalMs);
  };
}

module.exports = { createRetentionCleanup };
