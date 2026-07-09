const { Router } = require('express');
const {
  getDashboard,
  getDashboardWidgets,
  saveDashboardWidgets,
  getDashboardSystem,
} = require('../../controllers/dashboardController.js');

const router = Router();

router.get('/', getDashboard);
router.get('/system', getDashboardSystem);
router.get('/widgets', getDashboardWidgets);
router.put('/widgets', saveDashboardWidgets);

module.exports = router;
