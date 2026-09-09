const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOriginGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Fetch Metadata also catches cross-site forms in browsers omitting Origin.
  // Non-browser clients without these headers retain the existing API behavior.
  if (req.get('Sec-Fetch-Site') === 'cross-site') {
    return res.status(403).json({ ok: false, error: 'cross_origin_request' });
  }

  const source = req.get('Origin') || req.get('Referer');
  if (source) {
    try {
      const sourceUrl = new URL(source);
      const targetUrl = new URL(`${req.protocol}://${req.get('Host')}`);
      if (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.origin !== targetUrl.origin) {
        return res.status(403).json({ ok: false, error: 'cross_origin_request' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'cross_origin_request' });
    }
  }

  return next();
}

module.exports = requestOriginGuard;
