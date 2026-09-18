// Bounded original readings spanning the entire selected archive.
function readChart(db, { objectId, key = '', topic = '', from = '', to = '', limit = 2000 }) {
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
  return db.transaction(() => {
    const summary = db.prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS fromDate,
      MAX(created_at) AS toDate FROM object_readings WHERE ${where}`).get(...params);
    let readings;
    if (summary.total <= budget) {
      readings = db.prepare(`SELECT id, topic, value_key, value_text, raw_payload, created_at
        FROM object_readings WHERE ${where} ORDER BY created_at DESC, id DESC`).all(...params);
    } else {
      // Uniform row ranks include the oldest and newest reading. Only IDs
      // enter the window sort; payloads are fetched for selected rows only.
      readings = db.prepare(`WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS position
          FROM object_readings WHERE ${where}
        ), selected AS (
          SELECT id FROM ranked WHERE position = 1 OR
            CAST((position - 1) * ? / ? AS INTEGER) > CAST((position - 2) * ? / ? AS INTEGER)
        )
        SELECT r.id, r.topic, r.value_key, r.value_text, r.raw_payload, r.created_at
        FROM selected JOIN object_readings r ON r.id = selected.id
        ORDER BY r.created_at DESC, r.id DESC`).all(...params,
        budget - 1, summary.total - 1, budget - 1, summary.total - 1);
    }
    return { readings, total: summary.total, sampled: summary.total > budget,
      from: summary.fromDate, to: summary.toDate };
  })();
}

module.exports = { readChart };
