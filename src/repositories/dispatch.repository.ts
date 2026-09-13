import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { DispatchRow } from '../types/wms.types';

export class DispatchRepository {
  constructor(private readonly db: Pool) {}

  async findByOrderId(orderId: number): Promise<DispatchRow[]> {
    const [rows] = await this.db.query<SqlRow<DispatchRow>[]>(
      'SELECT * FROM dispatch WHERE order_id = ?',
      [orderId],
    );
    return rows;
  }

  /** Every dispatch row, optionally scoped by dock/departure status — bulk fetch for the canonical adapter; congestion/delay classification lives in the intelligence layer. */
  async findAll(filter: { dock?: string; departed?: boolean } = {}): Promise<DispatchRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.dock) {
      conditions.push('dock = ?');
      params.push(filter.dock);
    }
    if (filter.departed === true) conditions.push('departure_time IS NOT NULL');
    if (filter.departed === false) conditions.push('departure_time IS NULL');

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.db.query<SqlRow<DispatchRow>[]>(`SELECT * FROM dispatch ${whereClause}`, params);
    return rows;
  }
}
