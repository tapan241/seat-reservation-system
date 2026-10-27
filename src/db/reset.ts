import { pool } from './index.js';
import { initDB } from './init.js';

async function resetDB() {
  try {
    console.log('Resetting database...');
    await pool.query(`
      DROP TABLE IF EXISTS idempotency_records CASCADE;
      DROP TABLE IF EXISTS show_seats CASCADE;
      DROP TABLE IF EXISTS reservations CASCADE;
      DROP TABLE IF EXISTS shows CASCADE;
      DROP TYPE IF EXISTS seat_status CASCADE;
      DROP TYPE IF EXISTS reservation_status CASCADE;
    `);
    console.log('Dropped all existing tables and types.');
    await initDB(true);
    console.log('Database reset complete.');
  } catch (error) {
    console.error('Failed to reset database:', error);
    process.exit(1);
  }
}

resetDB();
