import fs from 'node:fs';
import path from 'node:path';
import { RowDataPacket } from 'mysql2';
import { pool, closePool } from './pool';
import { logger } from '../utils/logger';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationRow extends RowDataPacket {
  name: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const [rows] = await pool.query<MigrationRow[]>('SELECT name FROM _migrations');
  return new Set(rows.map((row) => row.name));
}

async function run(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const pending = files.filter((file) => !applied.has(file));

  if (pending.length === 0) {
    logger.info('No pending migrations. Database is up to date.');
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    // Strip full-line comments first — splitting on ';' alone would otherwise treat a
    // "comment followed by statement" block as a single chunk and, since it starts
    // with '--', discard the real statement along with it.
    const withoutComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = withoutComments
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    logger.info(`Applying migration: ${file}`);

    // DDL statements implicitly commit in MySQL/MariaDB, so each migration file is
    // expected to be idempotent (e.g. `ADD COLUMN IF NOT EXISTS`) rather than
    // relying on transactional rollback.
    for (const statement of statements) {
      await pool.query(statement);
    }

    await pool.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
    logger.info(`Migration applied: ${file}`);
  }
}

run()
  .then(() => closePool())
  .catch(async (error) => {
    logger.error('Migration run failed', { error: error instanceof Error ? error.message : error });
    await closePool();
    process.exit(1);
  });
