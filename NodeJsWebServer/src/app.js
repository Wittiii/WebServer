const path = require('path');
const express = require('express');
const session = require('express-session');

require('dotenv').config({ path: path.join(__dirname, 'config', '.env') });
const { clients } = require('./mqttBroker'); // Broker startet parallel und liefert Client-Status
const app = express();
const PORT = process.env.PORT || 3000;

// Statische Dateien aus /public bedienen
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
//Session für Admin Login
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {maxAge: 60 * 60 * 1000 } // 1 Stunde
}));

// Routen mounten
const authGuard = require('./middlewares/authGuard.js');
const homeRoutes = require('./routes/home/home');
app.use('/', homeRoutes);

//Dashboard-Route mit AuthGuard schützen
const dashboardRoutes = require('./routes/dashboard/dashboard.js');
app.use('/dashboard', authGuard, dashboardRoutes);

//Hydroponic-Route mit AuthGuard schützen
const hydroponicRoutes = require('./routes/Hydroponic/hydroponic.js');
app.use('/hydroponic', authGuard, hydroponicRoutes);

//Admin-Login-Route
const authRoutes = require('./routes/auth/auth');
app.use('/login', authRoutes);


app.get('/api/mqtt/clients', (req, res) => {
  const list = [...clients.entries()].map(([id, data]) => ({
    id,
    connected: data.connected,
    last: data.last,
    lastTopic: data.lastTopic || null
  }));
  res.json(list);
});

// 404-Fallback
app.use((req, res) => {
  res.status(404).send('Seite nicht gefunden');
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});



