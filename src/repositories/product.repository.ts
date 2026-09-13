import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { ProductRow } from '../types/wms.types';

export class ProductRepository {
  constructor(private readonly db: Pool) {}

  async findBySku(sku: string): Promise<ProductRow | null> {
    const [rows] = await this.db.query<SqlRow<ProductRow>[]>(
      'SELECT * FROM products WHERE sku = ? LIMIT 1',
      [sku],
    );
    return rows[0] ?? null;
  }

  async findAllActive(): Promise<ProductRow[]> {
    const [rows] = await this.db.query<SqlRow<ProductRow>[]>(
      'SELECT * FROM products WHERE active = 1',
    );
    return rows;
  }

  /** Every product row, active or not — bulk fetch for the canonical adapter, which lets the intelligence layer decide what "active" means. */
  async findAll(): Promise<ProductRow[]> {
    const [rows] = await this.db.query<SqlRow<ProductRow>[]>('SELECT * FROM products');
    return rows;
  }
}
