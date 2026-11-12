const { Router } = require('express');
const { getHome, getHomeOverview } = require('../../controllers/homeController.js');

const router = Router();

router.get('/', getHome);
router.get('/api/home/overview', getHomeOverview);

module.exports = router;
