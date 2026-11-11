const { Router } = require('express');
const { getHydroponic } = require('../../controllers/hydroponicController.js');

const router = Router();

router.get('/', getHydroponic);

module.exports = router;