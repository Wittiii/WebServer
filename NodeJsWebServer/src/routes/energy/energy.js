const { Router } = require("express");
const {
  getEnergyPage,
  getEnergyOverview,
  updateEnergySettings,
} = require("../../controllers/energyController");

const router = Router();

router.get("/", getEnergyPage);
router.get("/overview", getEnergyOverview);
router.put("/settings", updateEnergySettings);

module.exports = router;
