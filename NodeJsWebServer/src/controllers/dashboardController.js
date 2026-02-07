const path = require('path');

const getDashboard = (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public','pages','dashboard','dashboard.html');
  res.sendFile(filePath);
};

module.exports = { getDashboard };