const { Router } = require("express");
const {
  getConsoleLogs,
  getConsolePage,
  streamConsoleLogs,
} = require("../../controllers/consoleController");

const router = Router();

router.get("/", getConsolePage);
router.get("/logs", getConsoleLogs);
router.get("/stream", streamConsoleLogs);

module.exports = router;
