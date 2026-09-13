import { createApp } from './app';
import { env } from './config/env';
import { closePool } from './database';
import { exceptionScheduler } from './scheduler';
import { logger } from './utils/logger';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT}`, { env: env.NODE_ENV });
  exceptionScheduler.start();
});

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully`);
  exceptionScheduler.stop();
  server.close(() => {
    closePool()
      .catch((error) => logger.error('Error closing database pool', { error }))
      .finally(() => {
        logger.info('Server closed');
        process.exit(0);
      });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
