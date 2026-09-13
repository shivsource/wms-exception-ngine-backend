import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(6000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  SCHEDULER_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
  SCHEDULER_CRON: z.string().default('* * * * *'),
  /**
   * Which LogisticsDataSource implementation the intelligence layer runs against.
   * "wms_database" (default) adapts the existing MySQL WMS; "mock" runs against an
   * empty in-memory MockLogisticsDataSource — useful for demoing/booting without a DB.
   * See src/adapters/index.ts and ARCHITECTURE.md.
   */
  DATA_SOURCE: z.enum(['wms_database', 'mock']).default('wms_database'),
  /**
   * Optional anchor instant for `src/database/seed/*` ONLY — never read by the live
   * engine/predictors/rules (those always use `new Date()`, unchanged). When unset, the
   * seed scripts anchor to the real wall-clock time at the moment they run, which is what
   * keeps freshly-seeded SLA/picking/packing/dispatch windows correctly "future" relative
   * to whatever real time the live scheduler later evaluates them at — the exact problem
   * this variable exists to avoid recreating (a fixed, stale anchor going stale again).
   * Set it only for a one-off deterministic snapshot; expect that snapshot's relative
   * windows to erode in real time exactly like the old dataset did once "now" moves past it.
   */
  SIMULATION_TIME: z.string().datetime().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
