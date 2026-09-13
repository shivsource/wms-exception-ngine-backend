import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { PackingRow } from '../types/wms.types';

export class PackingRepository {
  constructor(private readonly db: Pool) {}

  async findByOrderId(orderId: number): Promise<PackingRow[]> {
    const [rows] = await this.db.query<SqlRow<PackingRow>[]>(
      'SELECT * FROM packing WHERE order_id = ?',
      [orderId],
    );
    return rows;
  }

  /** Every packing row — bulk fetch for the canonical adapter; overdue/backlog classification lives in the intelligence layer. */
  async findAll(): Promise<PackingRow[]> {
    const [rows] = await this.db.query<SqlRow<PackingRow>[]>('SELECT * FROM packing');
    return rows;
  }
}
