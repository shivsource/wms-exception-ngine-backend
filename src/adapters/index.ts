import { LogisticsDataSource } from '../canonical/logistics-data-source';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { MockLogisticsDataSource } from './mock';
import { WmsDatabaseAdapter } from './wms-database';

export * from './wms-database';
export * from './mock';

/**
 * Picks the LogisticsDataSource implementation for the DATA_SOURCE env var. This is the
 * only place in the codebase that knows every available adapter — adding a future source
 * (another WMS, a TMS, an API/webhook feed) means writing its adapter and adding one
 * case here, exactly like RuleRegistry does for exception rules.
 */
export class LogisticsDataSourceFactory {
  create(sourceId: string = env.DATA_SOURCE): LogisticsDataSource {
    switch (sourceId) {
      case 'wms_database':
        return new WmsDatabaseAdapter();
      case 'mock':
        return new MockLogisticsDataSource();
      default:
        throw new Error(`Unknown DATA_SOURCE "${sourceId}" — expected "wms_database" or "mock"`);
    }
  }
}

export const logisticsDataSourceFactory = new LogisticsDataSourceFactory();

/**
 * Singleton the intelligence layer imports — mirrors the existing singleton-repository
 * pattern (see src/repositories/index.ts) so rules/evidence collectors/analyzers use it
 * exactly the way they already use `inventoryRepository`, `orderRepository`, etc.
 */
export const logisticsDataSource: LogisticsDataSource = logisticsDataSourceFactory.create();

logger.info('Logistics data source selected', { source: logisticsDataSource.sourceId });
