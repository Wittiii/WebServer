const authGuard = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.session?.user) return next();
  return res.redirect('/login');
}

module.exports = authGuard;
