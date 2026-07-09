const { Router } = require("express");
const { getCameraPage } = require("../../controllers/cameraController");

const router = Router();

router.get("/", getCameraPage);

module.exports = router;
