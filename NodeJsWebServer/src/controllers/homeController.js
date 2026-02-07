const path = require('path');

const getHome = (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public','pages','home.html');
  res.sendFile(filePath);
};

module.exports = { getHome };
