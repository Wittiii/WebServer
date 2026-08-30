const { Router } = require("express");
const {
  getEnergyPage,
  getEnergyOverview,
  getUserEnergyLayout,
  updateEnergySettings,
  updateUserEnergyLayout,
  updateVictronBatterySettings,
} = require("../../controllers/energyController");

const router = Router();

router.get("/", getEnergyPage);
router.get("/overview", getEnergyOverview);
router.get("/layout", getUserEnergyLayout);
router.put("/layout", updateUserEnergyLayout);
router.put("/settings", updateEnergySettings);
router.put("/victron/battery-settings", updateVictronBatterySettings);

module.exports = router;
