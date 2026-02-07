const { Router } = require('express');
const { getHome } = require('../../controllers/homeController.js');

const router = Router();

router.get('/', getHome);

module.exports = router;
