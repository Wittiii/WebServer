const { Router } = require('express');
const { getClients, publishMessage, getTopicsWithLastMessage } = require('../../controllers/mqttController');
const apiAuth = require('../../middlewares/apiAuth');

const router = Router();

router.get('/clients', getClients);
router.get('/topics', getTopicsWithLastMessage);
router.post('/publish', apiAuth, publishMessage);

module.exports = router;
