/**
 * Express + Socket.IO HTTP server entry point.
 */
import express from 'express';
import http from 'http';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

import { env } from './config/env.js';
import { logger, apiLogger } from './utils/logger.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initSocketServer } from './sockets/index.js';
import { UPLOADS_ROOT } from './services/fileStorage.js';
import { startWorker, stopWorker } from './workers/sapSyncWorker.js';

import authRoutes from './routes/auth.js';
import ordersRoutes from './routes/orders.js';
import runsRoutes from './routes/runs.js';
import returnsRoutes from './routes/returns.js';
import pickingRoutes from './routes/picking.js';
import driverRoutes from './routes/driver.js';
import zonesRoutes from './routes/zones.js';
import driversRoutes from './routes/drivers.js';
import reportsRoutes from './routes/reports.js';
import auditRoutes from './routes/audit.js';
import customersRoutes from './routes/customers.js';
import trackingRoutes from './routes/tracking.js';
import failuresRoutes from './routes/failures.js';
import usersRoutes from './routes/users.js';
import analyticsRoutes from './routes/analytics.js';
import trackPublicRoutes from './routes/trackPublic.js';
import sapRoutes from './routes/sap.js';
import settingsRoutes from './routes/settings.js';
import addressesRoutes from './routes/addresses.js';
import { startDigestWorker, stopDigestWorker } from './workers/dailyDigestWorker.js';
import { startCleanupWorker, stopCleanupWorker } from './workers/cleanupWorker.js';
import { startCeoBriefScheduler, stopCeoBriefScheduler } from './workers/ceoBriefScheduler.js';
import { startDavoMixReportScheduler, stopDavoMixReportScheduler } from './workers/davoMixReportScheduler.js';
import agentsRoutes from './routes/agents.js';
import davoMixRoutes from './routes/davoMix.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

// Middleware
// Trust the first reverse proxy hop so req.ip / rate-limiter use X-Forwarded-For correctly.
app.set('trust proxy', 1);

// Security headers. CSP is conservative: API responses are JSON, so we disallow scripts.
// In production, the SPA is served from frontendDist below — its index.html may need
// extra script-src 'self' allowance, which is provided.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      // Allow inline styles for Helmet defaults + small CSS-in-JS chunks the SPA uses.
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS — explicit allow-list from CORS_ORIGINS env var (comma-separated).
// Same-origin requests (no Origin header) are allowed unconditionally.
const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server, curl, native apps
    if (allowedOrigins.includes(origin)) return cb(null, true);
    apiLogger.warn('CORS blocked', { origin });
    return cb(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny', { stream: { write: (msg) => apiLogger.http?.(msg.trim()) || apiLogger.info(msg.trim()) } }));

// Static uploads (signatures, photos)
app.use('/uploads', express.static(UPLOADS_ROOT, {
  maxAge: '7d',
  immutable: true,
}));

// Health check - includes SAP + DB status
app.get('/health', async (_req, res) => {
  const { checkHealth } = await import('./services/health.js');
  const health = await checkHealth();
  res.status(health.ok ? 200 : 503).json(health);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/picking', pickingRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/zones', zonesRoutes);
app.use('/api/drivers', driversRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/failures', failuresRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/sap', sapRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/addresses', addressesRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/davo-mix', davoMixRoutes);
// Public tracking - no auth required
app.use('/api/public/track', trackPublicRoutes);

// ============================================================================
// Production: serve built frontend from same port
// ============================================================================
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
if (env.NODE_ENV === 'production') {
  // Register SYNCHRONOUSLY so the static + SPA fallback come before app.use(notFound).
  // The previous async import('fs').then(...) registered after notFound, breaking SPA routes.
  if (existsSync(frontendDist)) {
    logger.info(`Serving frontend from ${frontendDist}`);
    app.use(express.static(frontendDist, { maxAge: '1d' }));
    // SPA fallback - all non-API routes → index.html
    app.get(/^(?!\/api|\/socket\.io|\/uploads|\/health).*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  } else {
    logger.warn(`frontend/dist not found at ${frontendDist} - frontend not served`);
  }
}

// 404 + error handler (must be last)
app.use(notFound);
app.use(errorHandler);

// Socket.IO
const io = initSocketServer(server);
app.set('io', io);

// Start
server.listen(env.PORT, () => {
  logger.info(`🚚 SAP Logistics Hub API listening on http://localhost:${env.PORT}`);
  logger.info(`   Environment: ${env.NODE_ENV}`);
  // Start background workers
  startWorker();
  startDigestWorker();
  startCleanupWorker();
  startCeoBriefScheduler();
  startDavoMixReportScheduler();
});

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down...`);
  stopWorker();
  stopDigestWorker();
  stopCleanupWorker();
  stopCeoBriefScheduler();
  stopDavoMixReportScheduler();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
