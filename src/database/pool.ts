import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  timezone: 'Z',
});

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    logger.error('Database ping failed', { error: error instanceof Error ? error.message : error });
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
