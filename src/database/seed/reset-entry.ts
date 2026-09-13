import { pool, closePool } from '../pool';
import { logger } from '../../utils/logger';
import { resetDatabase } from './reset';

/** `npm run db:reset` — truncates every operational + derived table, leaves the DB empty. Run `npm run db:seed` afterward to repopulate. */
resetDatabase(pool)
  .then(() => closePool())
  .catch(async (error) => {
    logger.error('Reset failed', { error: error instanceof Error ? error.stack : error });
    await closePool();
    process.exit(1);
  });
