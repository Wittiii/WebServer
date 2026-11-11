const db = require('../database/db');
const { readChart } = require('../services/readingChartService');

const MAX_READINGS_PER_REQUEST = 5000;

const listReadings = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  const key = typeof req.query?.key === 'string' ? req.query.key.trim() : '';
  const topic = typeof req.query?.topic === 'string' ? req.query.topic.trim() : '';
  const from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
  const to = typeof req.query?.to === 'string' ? req.query.to.trim() : '';
  const limitParam = String(req.query?.limit ?? '').trim();
  const limitRaw = Number(limitParam);
  const requestedAll = limitParam === '0' || limitParam.toLowerCase() === 'all';
  const limit = requestedAll
    ? MAX_READINGS_PER_REQUEST
    : limitParam && Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_READINGS_PER_REQUEST)
      : 100;

  if (req.query?.view === 'chart') {
    const parseDate = (value) => value ? new Date(value).toISOString() : '';
    let chartFrom, chartTo;
    try {
      chartFrom = parseDate(from);
      chartTo = parseDate(to);
      if (chartFrom && chartTo && chartFrom > chartTo) throw new Error('range');
    } catch {
      return res.status(400).json({ error: 'Ungueltiger Zeitraum: Von muss vor Bis liegen.' });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once?.('close', abort);
    try {
      const result = await readChart(db, { objectId: id, key, topic, from: chartFrom, to: chartTo,
        limit: limitParam ? limit : 2000 }, { signal: controller.signal });
      if (!controller.signal.aborted) return res.json(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err.code === 'CHART_BUSY') {
        res.set?.('Retry-After', '3');
        return res.status(503).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message });
    } finally {
      res.removeListener?.('close', abort);
    }
  }

  try {
    const params = [id];
    let sql = `
      SELECT id, topic, value_key, value_text, raw_payload, created_at
      FROM object_readings
      WHERE object_id = ?
    `;

    if (key) {
      sql += ' AND value_key = ?';
      params.push(key);
    }
    if (topic) {
      sql += ' AND topic = ?';
      params.push(topic);
    }
    if (from) {
      sql += ' AND created_at >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND created_at <= ?';
      params.push(to);
    }

    sql += ' ORDER BY id DESC';
    sql += ' LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteReadings = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });

  try {
    const info = db.prepare('DELETE FROM object_readings WHERE object_id = ?').run(id);
    res.json({ deleted: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  MAX_READINGS_PER_REQUEST,
  listReadings,
  deleteReadings
};
