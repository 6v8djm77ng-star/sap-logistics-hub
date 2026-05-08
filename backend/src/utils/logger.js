/**
 * Centralized logger using Winston.
 * Logs to console (dev) and file (production).
 */
import winston from 'winston';
import { env } from '../config/env.js';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${stack || message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: combine(errors({ stack: true }), timestamp()),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), consoleFormat),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: json(),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: json(),
    }),
  ],
});

// Subsystem loggers help filter noise quickly
export const sapLogger = logger.child({ module: 'SAP' });
export const dbLogger = logger.child({ module: 'DB' });
export const apiLogger = logger.child({ module: 'API' });
