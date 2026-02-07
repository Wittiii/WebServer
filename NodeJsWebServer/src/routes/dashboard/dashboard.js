const { Router } = require('express');
const { getDashboard } = require('../../controllers/dashboardController.js');

const router = Router();

router.get('/', getDashboard);

module.exports = router;