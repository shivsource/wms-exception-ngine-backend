import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { OrderItemRow } from '../types/wms.types';

export class OrderItemRepository {
  constructor(private readonly db: Pool) {}

  async findByOrderId(orderId: number): Promise<OrderItemRow[]> {
    const [rows] = await this.db.query<SqlRow<OrderItemRow>[]>(
      'SELECT * FROM order_items WHERE order_id = ?',
      [orderId],
    );
    return rows;
  }

  /** Every order_items row — bulk fetch for the canonical adapter, grouped by order_id by the caller. */
  async findAll(): Promise<OrderItemRow[]> {
    const [rows] = await this.db.query<SqlRow<OrderItemRow>[]>('SELECT * FROM order_items');
    return rows;
  }
}
