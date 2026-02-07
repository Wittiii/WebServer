const path = require('path');

const renderLogin = (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..',  '..','public', 'pages', 'login', 'login.html'));
};

const handleLogin = (req, res) => {
  const { username, password } = req.body;

    const validUsername = process.env.ADMIN_USER ;
    const validPassword = process.env.ADMIN_PASS ;


  if (username === validUsername && password===validPassword) {
    req.session.user = { username };
    return res.redirect('/');
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
