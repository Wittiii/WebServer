const path = require('path');

function safeReturnPath(value) {
  const target = String(value || '');
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

const renderLogin = (req, res) => {
  const returnTo = safeReturnPath(req.query.next);
  if (req.session?.user) return res.redirect(returnTo);
  if (returnTo !== '/') req.session.returnTo = returnTo;
  res.sendFile(path.join(__dirname, '..',  '..','public', 'pages', 'login', 'login.html'));
};

const handleLogin = (req, res) => {
  const { username, password } = req.body;

    const validUsername = process.env.ADMIN_USER ;
    const validPassword = process.env.ADMIN_PASS ;


  if (username === validUsername && password===validPassword) {
    req.session.user = { username };
    const returnTo = safeReturnPath(req.session.returnTo);
    delete req.session.returnTo;
    return req.session.save((error) => {
      if (error) return res.status(500).send('Session konnte nicht gespeichert werden');
      return res.redirect(returnTo);
    });
  }
  res.status(401).send('Ungültige Daten');
};

const handleLogout = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
};

const getStatus = (req, res) => {
  res.json({
    loggedIn: Boolean(req.session?.user),
    user: req.session?.user || null,
  });
};

module.exports = { renderLogin, handleLogin, handleLogout, getStatus };
