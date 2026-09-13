import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { ReturnRow } from '../types/wms.types';

export class ReturnRepository {
  constructor(private readonly db: Pool) {}

  /** Every returns row, optionally scoped by sku/returned-since — bulk fetch for the canonical adapter; rate/window classification lives in the intelligence layer. */
  async findAll(filter: { sku?: string; returnedFrom?: Date } = {}): Promise<ReturnRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.sku) {
      conditions.push('sku = ?');
      params.push(filter.sku);
    }
    if (filter.returnedFrom) {
      conditions.push('returned_at >= ?');
      params.push(filter.returnedFrom);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await this.db.query<SqlRow<ReturnRow>[]>(`SELECT * FROM returns ${whereClause}`, params);
    return rows;
  }
}
