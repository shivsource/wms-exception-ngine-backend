import { schedule, validate, ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { exceptionEngine } from '../engine';
import { logger } from '../utils/logger';

/**
 * Drives the exception engine on a cron interval. Overlap-safe: if a run is still
 * in flight when the next tick fires, the tick is skipped rather than stacking
 * concurrent engine runs against the database.
 */
export class ExceptionScheduler {
  private task: ScheduledTask | null = null;
  private isRunning = false;

  start(): void {
    if (!env.SCHEDULER_ENABLED) {
      logger.info('Exception scheduler disabled via SCHEDULER_ENABLED=false');
      return;
    }

    if (!validate(env.SCHEDULER_CRON)) {
      throw new Error(`Invalid SCHEDULER_CRON expression: ${env.SCHEDULER_CRON}`);
    }

    this.task = schedule(env.SCHEDULER_CRON, () => {
      void this.runOnce();
    });

    logger.info('Exception scheduler started', { cron: env.SCHEDULER_CRON });
  }

  stop(): void {
    this.task?.stop();
    logger.info('Exception scheduler stopped');
  }

  private async runOnce(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Skipping scheduled run: previous engine run is still in progress');
      return;
    }

    this.isRunning = true;
    try {
      await exceptionEngine.run();
    } catch (error) {
      logger.error('Scheduled engine run failed', {
        error: error instanceof Error ? error.message : error,
      });
    } finally {
      this.isRunning = false;
    }
  }
}

export const exceptionScheduler = new ExceptionScheduler();
