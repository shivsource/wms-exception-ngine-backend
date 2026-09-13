import { Pool } from 'mysql2/promise';
import { logger } from '../../utils/logger';

/**
 * Truncates every table this project's operational/intelligence pipeline owns data in —
 * both the WMS operational tables (owned by the WMS, but this is the dataset the user asked
 * to be reset) and this app's own derived tables (exceptions/predictions/root-cause/
 * recommendations/actions/outcomes). The derived tables are cleared too: they are entirely
 * re-derivable from WMS data by the existing engines, and leaving stale rows that reference
 * now-deleted orders/tasks would silently corrupt validation (orphaned entity_id references,
 * exceptions that can never resolve because their order no longer exists). Nothing here
 * touches `_migrations` or the intelligence-layer table *schemas* — only their rows.
 *
 * TRUNCATE with FOREIGN_KEY_CHECKS disabled (rather than DELETE in dependency order) so the
 * whole reset is one atomic-feeling operation and every AUTO_INCREMENT counter restarts at 1.
 */
const TABLES_CHILD_FIRST = [
  // This app's derived/intelligence tables.
  'action_outcomes',
  'actions',
  'exception_recommendations',
  'root_cause_analyses',
  'exceptions',
  'predictions',
  // WMS operational tables.
  'picking_task_items',
  'returns',
  'dispatch',
  'packing',
  'picking_tasks',
  'order_items',
  'orders',
  'inventory',
  'products',
] as const;

export async function resetDatabase(pool: Pool): Promise<void> {
  logger.info('Resetting database: truncating operational + derived tables', { tables: TABLES_CHILD_FIRST });
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of TABLES_CHILD_FIRST) {
      await pool.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  logger.info('Reset complete: all tables truncated, AUTO_INCREMENT counters restarted at 1');
}
