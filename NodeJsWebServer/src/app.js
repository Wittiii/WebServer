const path = require("path");
const express = require("express");
const session = require("express-session");

require("dotenv").config({ path: path.join(__dirname, "config", ".env") });
require("./database/db");
const { startAutomationEngine } = require("./services/automationService");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60 * 60 * 1000 },
  })
);

const authGuard = require("./middlewares/authGuard.js");

const homeRoutes = require("./routes/home/home");
const dashboardRoutes = require("./routes/dashboard/dashboard.js");
const cameraRoutes = require("./routes/camera/camera.js");
const hydroponicRoutes = require("./routes/Hydroponic/hydroponic.js");
const authRoutes = require("./routes/auth/auth");
const objectsRoutes = require("./routes/database/database.js");
const mqttRoutes = require("./routes/mqtt/mqtt");
const cameraApiRoutes = require("./routes/camera/cameraApi");

app.use("/", homeRoutes);
app.use("/dashboard", authGuard, dashboardRoutes);
app.use("/camera", authGuard, cameraRoutes);
app.use("/hydroponic", authGuard, hydroponicRoutes);
app.use("/login", authRoutes);

app.use("/api/objects", authGuard, objectsRoutes);
app.use("/api/mqtt", mqttRoutes);
app.use("/api/camera", cameraApiRoutes);

app.use((req, res) => {
  res.status(404).send("Seite nicht gefunden");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server laeuft auf Port ${PORT}`);
});

startAutomationEngine();
