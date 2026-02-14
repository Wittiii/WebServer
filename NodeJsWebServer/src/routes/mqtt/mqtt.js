const { Router } = require('express');
const { getClients, publishMessage } = require('../../controllers/mqttController');
const apiAuth = require('../../middlewares/apiAuth');

const router = Router();

router.get('/clients', getClients);
router.post('/publish', apiAuth, publishMessage);

module.exports = router;
