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
  const io = new Server(httpServer, {
    cors: { origin: '*' }, // tighten for production
    transports: ['websocket', 'polling'],
  });

  // Auth middleware
  io.use((socket, next) => {
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
