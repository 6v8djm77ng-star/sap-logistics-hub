/**
 * Socket.IO setup for real-time updates.
 *
 * Channels:
 *   - "planner"  : planner UI (all events about runs, orders, returns)
 *   - "warehouse": picking events
 *   - "driver:<driverId>": per-driver updates
 */
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';

export function initSocketServer(httpServer) {
  // Same allow-list as the Express CORS gate (server.js). A stolen JWT used to
  // be acceptable from any origin (cors:'*'); now the WebSocket is bound to the
  // same approved origins as the REST API.
  // Server-to-server / native clients (no Origin header) are still allowed,
  // matching server.js behavior.
  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        apiLogger.warn('Socket.IO CORS blocked', { origin });
        return cb(new Error('Origin not allowed by Socket.IO CORS'));
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Auth middleware — JWT first, then defense-in-depth Origin check (browsers
  // can lie about Origin only with extension-level access; this is belt-and-
  // suspenders so a non-browser client with a stolen JWT can't subscribe).
  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      apiLogger.warn('Socket.IO handshake rejected: bad origin', { origin });
      return next(new Error('Origin not allowed'));
    }
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No auth token'));
    try {
      socket.user = jwt.verify(token, env.JWT_SECRET);
      next();
    } catch (e) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    apiLogger.info('Socket connected', { user: socket.user?.username || socket.user?.name });

    // Auto-join rooms based on role
    if (socket.user.role === 'PLANNER' || socket.user.role === 'ADMIN') {
      socket.join('planner');
    }
    if (socket.user.role === 'WAREHOUSE' || socket.user.role === 'ADMIN') {
      socket.join('warehouse');
    }
    if (socket.user.role === 'DRIVER') {
      socket.join(`driver:${socket.user.driverId}`);
    }

    socket.on('disconnect', () => {
      apiLogger.info('Socket disconnected', { user: socket.user?.username });
    });
  });

  return io;
}
