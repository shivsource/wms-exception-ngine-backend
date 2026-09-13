import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { PickingTaskRow, PickingTaskStatus } from '../types/wms.types';

export class PickingTaskRepository {
  constructor(private readonly db: Pool) {}

  async findById(id: number): Promise<PickingTaskRow | null> {
    const [rows] = await this.db.query<SqlRow<PickingTaskRow>[]>(
      'SELECT * FROM picking_tasks WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ?? null;
  }

  /** Looks up a task by its human-readable code (e.g. "TASK-100") rather than its numeric FK. */
  async findByTaskCode(taskCode: string): Promise<PickingTaskRow | null> {
    const [rows] = await this.db.query<SqlRow<PickingTaskRow>[]>(
      'SELECT * FROM picking_tasks WHERE task_id = ? LIMIT 1',
      [taskCode],
    );
    return rows[0] ?? null;
  }

  /** Every picking_tasks row, optionally scoped by status — bulk fetch for the canonical adapter; threshold/timing classification lives in the intelligence layer. */
  async findAll(filter: { status?: PickingTaskStatus[] } = {}): Promise<PickingTaskRow[]> {
    if (!filter.status || filter.status.length === 0) {
      const [rows] = await this.db.query<SqlRow<PickingTaskRow>[]>('SELECT * FROM picking_tasks');
      return rows;
    }
    const placeholders = filter.status.map(() => '?').join(', ');
    const [rows] = await this.db.query<SqlRow<PickingTaskRow>[]>(
      `SELECT * FROM picking_tasks WHERE status IN (${placeholders})`,
      filter.status,
    );
    return rows;
  }
}
