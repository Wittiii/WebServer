const { Router } = require("express");

const apiAuth = require("../../middlewares/apiAuth");
const {
  buildTimelapse,
  deleteTimelapse,
  getOverview,
  getTimelapse,
  getTimelapseFile,
  sendCommand,
} = require("../../controllers/cameraController");

const router = Router();

router.get("/overview", apiAuth, getOverview);
router.get("/timelapse", apiAuth, getTimelapse);
router.get("/timelapse/file", apiAuth, getTimelapseFile);
router.post("/command", apiAuth, sendCommand);
router.post("/timelapse/build", apiAuth, buildTimelapse);
router.post("/timelapse/delete", apiAuth, deleteTimelapse);

module.exports = router;
