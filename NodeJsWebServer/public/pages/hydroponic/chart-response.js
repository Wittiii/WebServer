(function (root) {
  function normalizeChartResponse(payload, limit = 2000) {
    const legacy = Array.isArray(payload);
    const rows = legacy ? payload : payload?.readings;
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object'
      || !Number.isFinite(Date.parse(row.created_at)))) {
      throw new Error('Der Server hat keine lesbaren Messwerte geliefert. Bitte erneut laden oder den Serverstand prüfen.');
    }
    const readings = rows.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(b.id || 0) - Number(a.id || 0));
    return {
      readings,
      legacy,
      possiblyTruncated: legacy && readings.length >= limit,
      total: legacy ? null : payload.total,
      sampled: !legacy && payload.sampled === true,
      omittedTextValues: Number(payload?.omittedTextValues || 0),
      from: legacy ? readings.at(-1)?.created_at : payload.from,
      to: legacy ? readings[0]?.created_at : payload.to,
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { normalizeChartResponse };
  else root.HydroChart = { normalizeChartResponse };
})(globalThis);
