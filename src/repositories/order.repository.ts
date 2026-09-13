import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { OrderRow } from '../types/wms.types';

export class OrderRepository {
  constructor(private readonly db: Pool) {}

  async findById(id: number): Promise<OrderRow | null> {
    const [rows] = await this.db.query<SqlRow<OrderRow>[]>(
      'SELECT * FROM orders WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ?? null;
  }

  /** Looks up an order by its human-readable code (e.g. "ORD-100160") rather than its numeric FK. */
  async findByOrderCode(orderCode: string): Promise<OrderRow | null> {
    const [rows] = await this.db.query<SqlRow<OrderRow>[]>(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1',
      [orderCode],
    );
    return rows[0] ?? null;
  }

  /** Every order row — bulk fetch for the canonical adapter; window/status classification lives in the intelligence layer. */
  async findAll(): Promise<OrderRow[]> {
    const [rows] = await this.db.query<SqlRow<OrderRow>[]>('SELECT * FROM orders');
    return rows;
  }
}
