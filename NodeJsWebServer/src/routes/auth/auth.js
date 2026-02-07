const { Router } = require('express');
const { renderLogin, handleLogin, handleLogout, getStatus} = require('../../controllers/authController.js');

const router = Router();
router.get('/', renderLogin);
router.post('/', handleLogin);
router.post('/logout', handleLogout); // POST /login/logout
router.get('/status', getStatus);    // GET /login/status
// router.post('/logout', handleLogout);

module.exports = router;
