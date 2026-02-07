const path = require('path');

const getHydroponic = (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public','pages','hydroponic','hydroponic.html');
  res.sendFile(filePath);
};

module.exports = { getHydroponic };