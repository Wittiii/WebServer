const path = require('path');
const { safeReturnPath, credentialsMatch, createLoginAttemptLimiter } = require('../services/loginSecurityService');

const loginAttempts = createLoginAttemptLimiter();

const renderLogin = (req, res) => {
  res.set('Cache-Control', 'no-store');
  const returnTo = safeReturnPath(req.query.next);
  if (req.session?.user) return res.redirect(returnTo);
  if (returnTo !== '/') req.session.returnTo = returnTo;
  else delete req.session.returnTo;
  res.sendFile(path.join(__dirname, '..',  '..','public', 'pages', 'login', 'login.html'));
};

const handleLogin = (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { username, password } = req.body || {};
  const validUsername = process.env.ADMIN_USER;
  const validPassword = process.env.ADMIN_PASS;

  if (!validUsername || !validPassword) {
    return res.status(503).send('Anmeldung ist nicht konfiguriert');
  }

  // Express only trusts proxy headers if the operator explicitly configures it.
  const clientKey = req.ip || req.socket?.remoteAddress || 'unknown';
  const retryAfter = loginAttempts.retryAfter(clientKey);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send('Zu viele Anmeldeversuche. Bitte spaeter erneut versuchen.');
  }

  if (!credentialsMatch(username, password, validUsername, validPassword)) {
    loginAttempts.recordFailure(clientKey);
    return res.status(401).send('Ungueltige Daten');
  }

  const returnTo = safeReturnPath(req.session.returnTo);
  // A successful login must not reuse a session ID established before login.
  return req.session.regenerate((error) => {
    if (error) return res.status(500).send('Session konnte nicht erstellt werden');
    req.session.user = { username };
    return req.session.save((saveError) => {
      if (saveError) return res.status(500).send('Session konnte nicht gespeichert werden');
      loginAttempts.reset(clientKey);
      return res.redirect(returnTo);
    });
  });
};

const handleLogout = (req, res) => {
  res.set('Cache-Control', 'no-store');
  req.session.destroy((error) => {
    if (error) return res.status(500).send('Abmeldung fehlgeschlagen');
    res.clearCookie('connect.sid', { path: '/' });
    res.redirect('/');
  });
};

const getStatus = (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    loggedIn: Boolean(req.session?.user),
    user: req.session?.user || null,
  });
};

module.exports = { renderLogin, handleLogin, handleLogout, getStatus };
