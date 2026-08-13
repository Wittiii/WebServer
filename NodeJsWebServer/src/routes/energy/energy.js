const { Router } = require("express");
const { getEnergyPage, getEnergyOverview } = require("../../controllers/energyController");

const router = Router();

router.get("/", getEnergyPage);
router.get("/overview", getEnergyOverview);

module.exports = router;
