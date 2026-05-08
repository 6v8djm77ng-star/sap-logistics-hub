/**
 * Centralized error handler + async route wrapper.
 */
import { apiLogger } from '../utils/logger.js';
import { env } from '../config/env.js';

// Wrap async route handlers so errors reach Express
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, res) {
  apiLogger.warn('Route not found', { method: req.method, path: req.originalUrl });
  res.status(404).json({ error: 'Not Found' });
}

// 5xx → opaque message, 4xx → actual message (Zod validation, auth errors, etc.)
function isClientError(status) {
  return status >= 400 && status < 500;
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  apiLogger.error('Unhandled error', {
    message: err.message,
    status,
    path: req.path,
    method: req.method,
    // Stack only in server logs, never in HTTP response.
    stack: env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  // For 5xx, return a generic message to avoid leaking implementation details
  // (SQL syntax, file paths, library names). For 4xx, the message is part of the
  // contract (validation errors, auth failures).
  const responseMessage = isClientError(status)
    ? (err.message || 'Bad Request')
    : 'Internal Server Error';

  // Zod errors carry structured details that are safe to expose under 4xx.
  const responseBody = { error: responseMessage };
  if (isClientError(status) && err.issues) {
    responseBody.issues = err.issues;
  }

  res.status(status).json(responseBody);
}
