import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './index.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function initDB(closePool = false) {
  try {
    let schemaPath = path.join(__dirname, 'schema.sql');
    try {
      await fs.access(schemaPath);
    } catch {
      schemaPath = path.join(process.cwd(), 'src/db/schema.sql');
    }

    const sql = await fs.readFile(schemaPath, 'utf-8');
    await pool.query(sql);
    logger.info('Database schema initialized successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize database');
    throw error;
  } finally {
    if (closePool) {
      await pool.end();
    }
  }
}

// Auto-run if executed directly as a script (e.g. `npm run db:init`)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('init.ts') ||
  process.argv[1].endsWith('init.js')
);

if (isDirectRun) {
  initDB(true).catch(() => process.exit(1));
}