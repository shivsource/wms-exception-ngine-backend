import { describe, expect, it } from 'vitest';
import { LogisticsDataSourceFactory } from './index';
import { MockLogisticsDataSource } from './mock';
import { WmsDatabaseAdapter } from './wms-database';

describe('LogisticsDataSourceFactory (source configuration)', () => {
  const factory = new LogisticsDataSourceFactory();

  it('returns a WmsDatabaseAdapter for "wms_database"', () => {
    const source = factory.create('wms_database');
    expect(source).toBeInstanceOf(WmsDatabaseAdapter);
    expect(source.sourceId).toBe('wms_database');
  });

  it('returns a MockLogisticsDataSource for "mock"', () => {
    const source = factory.create('mock');
    expect(source).toBeInstanceOf(MockLogisticsDataSource);
    expect(source.sourceId).toBe('mock');
  });

  it('throws for an unrecognized source id rather than silently defaulting', () => {
    expect(() => factory.create('some_other_wms')).toThrow(/Unknown DATA_SOURCE/);
  });
});
