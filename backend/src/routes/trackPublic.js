/**
 * PUBLIC tracking routes - no auth required.
 * Used by customers who received an SMS link to track their delivery.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as tokens from '../services/trackingTokens.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Rate limit to prevent abuse (e.g. scraping all tokens)
// Uses in-memory store - fine for a single instance
let limiter;
try {
  // eslint-disable-next-line new-cap
  limiter = rateLimit({
    windowMs: 60_000, // 1 minute
    max: 30, // 30 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
  });
} catch {
  limiter = (req, res, next) => next();
}

router.use(limiter);

/**
 * GET /api/public/track/:token
 * Returns tracking info or 404.
 */
router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const info = await tokens.getTrackingInfo(req.params.token);
    if (!info) {
      return res.status(404).json({
        error: 'Token not found or expired',
        message: 'הקישור פג תוקף או שגוי',
      });
    }
    res.json(info);
  })
);

export default router;
