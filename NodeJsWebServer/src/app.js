const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { BoundedMemorySessionStore } = require('./services/boundedMemorySessionStore');
const requestOriginGuard = require('./middlewares/requestOriginGuard');
const authGuard = require('./middlewares/authGuard');
const apiAuth = require('./middlewares/apiAuth');

// HTTP configuration is separate from listeners and background-job lifecycles.
function createApp({ sessionStore = new BoundedMemorySessionStore(), health } = {}) {
  if (!process.env.SESSION_SECRET) {
    sessionStore.close();
    throw new Error('SESSION_SECRET must be configured');
  }
  const app = express();
  app.disable('x-powered-by');
  // Configure only known proxy IPs/subnets, never arbitrary forwarded headers.
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY.split(',').map((entry) => entry.trim()).filter(Boolean));
  }
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 100 }));
  app.use(express.json({ limit: '100kb' }));
  app.use(session({
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' },
  }));
  app.use(requestOriginGuard);
  app.use('/', require('./routes/home/home'));
  app.use('/dashboard', authGuard, require('./routes/dashboard/dashboard'));
  app.use('/camera', authGuard, require('./routes/camera/camera'));
  app.use('/console', authGuard, require('./routes/console/console'));
  app.use('/energy', authGuard, require('./routes/energy/energy'));
  app.use('/hydroponic', authGuard, require('./routes/Hydroponic/hydroponic'));
  app.use('/login', require('./routes/auth/auth'));
  app.use('/api/objects', apiAuth, require('./routes/database/database'));
  app.use('/api/mqtt', require('./routes/mqtt/mqtt'));
  app.use('/api/camera', require('./routes/camera/cameraApi'));
  app.get('/api/system/status', apiAuth, (_req, res) => res.json(health?.snapshot() || { ok: true }));
  app.use((_req, res) => res.status(404).send('Seite nicht gefunden'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('[HTTP] request failed', error);
    const message = status === 413 ? 'request_too_large' : status === 400 ? 'invalid_request' : 'request_failed';
    if (req.path.startsWith('/api/')) return res.status(status).json({ ok: false, error: message });
    return res.status(status).send(message);
  });
  app.locals.sessionStore = sessionStore;
  return app;
}

module.exports = { createApp };

// Preserve existing Raspberry Pi service commands.
if (require.main === module) void require('./server').run();
