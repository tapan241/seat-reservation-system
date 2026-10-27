import express, { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pinoHttp } from 'pino-http';
import client from '@prometheus-io/client';
import { logger } from './utils/logger.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { AppRequest } from './types.js';
import { showsRouter } from './routes/shows.js';
import { reservationsRouter } from './routes/reservations.js';
import { initDB } from './db/init.js';
import { pool } from './db/index.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use((req: AppRequest, res: Response, next: NextFunction) => {
  req.id = req.headers['x-request-id'] as string || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use(pinoHttp({
  logger,
  genReqId: (req: any) => req.id,
  autoLogging: false,
}));

app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Seat Reservation API',
    version: '1.0.0',
    description: 'High-concurrency seat reservation service. Guarantees no double sells, per user limits, and idempotent retries under load.',
    endpoints: {
      shows: {
        'POST /shows': 'Create a new show with seats and pricing (admin only)',
        'GET /shows/:id': 'Get show details, per-seat status, and reconciliation invariant',
        'POST /shows/:id/reserve': 'Reserve one or more seats for the authenticated user',
      },
      reservations: {
        'POST /reservations/:id/cancel': 'Cancel an active reservation (owner only)',
      },
      system: {
        'GET /health': 'Health summary',
        'GET /health/live': 'Liveness probe',
        'GET /health/ready': 'Readiness probe (verifies database connectivity)',
        'GET /metrics': 'Prometheus metrics',
      },
    },
    docs: 'https://github.com/tapan241/seat-reservation-system#readme',
  });
});

app.use('/shows', showsRouter);
app.use('/reservations', reservationsRouter);

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    const metrics = await client.register.metrics();
    res.send(metrics);
  } catch (ex) {
    res.status(500).end();
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'degraded', database: 'disconnected' });
  }
});

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use(errorHandler);

async function startServer() {
  try {
    await initDB();
    const server = app.listen(port, () => {
      logger.info(`Server running on port ${port}`);
    });

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal, shutting down gracefully...');
      server.close(async () => {
        logger.info('HTTP server closed, closing database pool...');
        try {
          await pool.end();
          logger.info('Database pool closed, process exit.');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error closing database pool');
          process.exit(1);
        }
      });

      setTimeout(() => {
        logger.error('Graceful shutdown timed out after 10s, forcing exit');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    logger.error({ err }, 'Failed to initialize database on startup');
    process.exit(1);
  }
}

startServer();