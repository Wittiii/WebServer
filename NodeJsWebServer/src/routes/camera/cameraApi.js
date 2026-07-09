const { Router } = require("express");

const apiAuth = require("../../middlewares/apiAuth");
const { getOverview, sendCommand } = require("../../controllers/cameraController");

const router = Router();

router.get("/overview", apiAuth, getOverview);
router.post("/command", apiAuth, sendCommand);

module.exports = router;
