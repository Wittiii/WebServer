function apiAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ ok: false, error: 'not_authenticated' });
}

module.exports = apiAuth;
