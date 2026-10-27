import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db/index.js';
import { AppRequest } from '../types.js';
import { logger } from '../utils/logger.js';
import { reservationsDeclinedTotal } from '../utils/metrics.js';

export const checkIdempotency = async (req: AppRequest, res: Response, next: NextFunction): Promise<void> => {
  const idempotencyKey = req.body?.idempotency_key;

  if (!idempotencyKey) {
    return next();
  }

  const userId = req.user?.id;
  const requestedSeats = req.body.seats ? [...req.body.seats].sort().join(',') : '';
  const requestHash = crypto.createHash('sha256').update(requestedSeats).digest('hex');

  try {
    const result = await pool.query(
      `SELECT request_hash, response_status, response_body 
       FROM idempotency_records 
       WHERE key = $1 AND user_id = $2`,
      [idempotencyKey, userId]
    );

    if (result.rowCount && result.rowCount > 0) {
      const record = result.rows[0];

      if (record.request_hash !== requestHash) {
        logger.warn({ key: idempotencyKey }, 'Idempotency key reused with different payload');
        reservationsDeclinedTotal.inc({ reason: 'IDEMPOTENCY_MISMATCH' });
        res.status(409).json({
          error: 'Conflict',
          message: 'Idempotency key reused with a different request payload.',
          reason: 'IDEMPOTENCY_MISMATCH'
        });
        return;
      }

      logger.info({ key: idempotencyKey }, 'Idempotency cache hit. Replaying response.');
      res.setHeader('X-Idempotency-Cache', 'HIT');
      res.status(record.response_status).json(record.response_body);
      return;
    }

    (req as any).requestHash = requestHash;
    next();

  } catch (error) {
    next(error);
  }
};