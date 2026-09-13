import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { InventoryRow } from '../types/wms.types';

export class InventoryRepository {
  constructor(private readonly db: Pool) {}

  /** Per-location stock breakdown for a single SKU — where the shortfall is physically located. */
  async findBySku(sku: string): Promise<InventoryRow[]> {
    const [rows] = await this.db.query<SqlRow<InventoryRow>[]>(
      'SELECT * FROM inventory WHERE sku = ?',
      [sku],
    );
    return rows;
  }

  /** Every inventory row — bulk fetch for the canonical adapter; grouping/threshold logic lives in the intelligence layer. */
  async findAll(): Promise<InventoryRow[]> {
    const [rows] = await this.db.query<SqlRow<InventoryRow>[]>('SELECT * FROM inventory');
    return rows;
  }
}
