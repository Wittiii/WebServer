const { setImmediate: yieldToServer } = require('node:timers/promises');

// Indexed time samples avoid sorting every historical row on the Node thread.
// Each block releases its read locks before yielding so MQTT can keep writing,
// including with the default DELETE journal mode.
async function queryChart(db, { objectId, key = '', topic = '', from = '', to = '', limit = 2000 }, { signal } = {}) {
  const conditions = ['object_id = ?'];
  const params = [objectId];
  for (const [column, operator, value] of [
    ['value_key', '=', key], ['topic', '=', topic],
    ['created_at', '>=', from], ['created_at', '<=', to],
  ]) {
    if (value) { conditions.push(`${column} ${operator} ?`); params.push(value); }
  }
  const where = conditions.join(' AND ');
  const budget = Math.min(5000, Math.max(2, Math.trunc(Number(limit) || 2000)));
  // Raw MQTT JSON is repeated on every key reading. The graph only needs the
  // extracted value; transferring those payloads can consume hundreds of MB.
  const columns = `id, topic, value_key, created_at,
    CASE WHEN length(value_text) <= 4096 THEN value_text ELSE NULL END AS value_text,
    CASE WHEN length(value_text) > 4096 THEN 1 ELSE 0 END AS text_omitted`;
  signal?.throwIfAborted();
  const snapshot = db.transaction(() => {
    const summary = db.prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS fromDate,
      MAX(created_at) AS toDate, MAX(id) AS maxId FROM object_readings WHERE ${where}`).get(...params);
    if (summary.total <= budget) {
      const readings = db.prepare(`SELECT ${columns}
        FROM object_readings WHERE ${where} ORDER BY created_at DESC, id DESC`).all(...params);
      return { summary, readings };
    }
    return { summary };
  })();
  const { summary } = snapshot;
  let readings = snapshot.readings;
  if (!readings) {
    const bounded = `${where} AND id <= ?`;
    const values = [...params, summary.maxId];
    const first = db.prepare(`SELECT ${columns} FROM object_readings WHERE ${bounded}
      ORDER BY created_at, id LIMIT 1`).get(...values);
    const last = db.prepare(`SELECT ${columns} FROM object_readings WHERE ${bounded}
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(...values);
    const points = new Map();
    if (first) points.set(first.id, first);
    if (last) points.set(last.id, last);
    const seek = db.prepare(`SELECT ${columns} FROM object_readings WHERE ${bounded}
      AND created_at >= ? ORDER BY created_at, id LIMIT 1`);
    const start = Date.parse(summary.fromDate);
    const span = Date.parse(summary.toDate) - start;
    for (let index = 1; index < budget - 1 && span > 0; index++) {
      if (index % 32 === 1) {
        await yieldToServer();
        signal?.throwIfAborted();
      }
      const target = new Date(start + span * index / (budget - 1)).toISOString();
      const row = seek.get(...values, target);
      if (row) points.set(row.id, row);
    }
    readings = [...points.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  }
  return { readings, total: summary.total, sampled: summary.total > readings.length,
    omittedTextValues: readings.filter((row) => row.text_omitted).length,
    from: summary.fromDate, to: summary.toDate };
}

const gates = new WeakMap();
function readChart(db, query, options = {}) {
  let gate = gates.get(db);
  if (!gate) { gate = { active: false, waiting: [] }; gates.set(db, gate); }
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  if (gate.active && gate.waiting.length >= 2) {
    return Promise.reject(Object.assign(new Error('Graph ausgelastet. Bitte in wenigen Sekunden erneut laden.'), { code: 'CHART_BUSY' }));
  }
  return new Promise((resolve, reject) => {
    const task = { query, options, resolve, reject };
    const run = async (current) => {
      gate.active = true;
      try { current.resolve(await queryChart(db, current.query, current.options)); }
      catch (error) { current.reject(error); }
      finally {
        const next = gate.waiting.shift();
        if (next) void run(next); else gate.active = false;
      }
    };
    if (gate.active) gate.waiting.push(task); else void run(task);
  });
}

module.exports = { readChart };
