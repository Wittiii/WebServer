const { Router } = require("express");

const apiAuth = require("../../middlewares/apiAuth");
const {
  buildTimelapse,
  deleteTimelapse,
  getAudioClipFile,
  getAudioOverview,
  getOverview,
  getSnapshot,
  getTimelapse,
  getTimelapseFile,
  postAudioEvent,
  removeAudioClip,
  saveAudioSettings,
  sendCommand,
} = require("../../controllers/cameraController");

const router = Router();

router.get("/overview", apiAuth, getOverview);
router.get("/snapshot", apiAuth, getSnapshot);
router.get("/timelapse", apiAuth, getTimelapse);
router.get("/timelapse/file", apiAuth, getTimelapseFile);
router.get("/audio", apiAuth, getAudioOverview);
router.get("/audio/clip", apiAuth, getAudioClipFile);
router.post("/audio/settings", apiAuth, saveAudioSettings);
router.post("/audio/event", apiAuth, postAudioEvent);
router.post("/audio/clip/delete", apiAuth, removeAudioClip);
router.post("/command", apiAuth, sendCommand);
router.post("/timelapse/build", apiAuth, buildTimelapse);
router.post("/timelapse/delete", apiAuth, deleteTimelapse);

module.exports = router;
