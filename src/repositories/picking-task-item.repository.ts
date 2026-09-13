import { Pool } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { PickingTaskItemRow } from '../types/wms.types';

export class PickingTaskItemRepository {
  constructor(private readonly db: Pool) {}

  /** All line items belonging to a single picking task, regardless of pick/error status. */
  async findByTaskId(taskId: number): Promise<PickingTaskItemRow[]> {
    const [rows] = await this.db.query<SqlRow<PickingTaskItemRow>[]>(
      'SELECT * FROM picking_task_items WHERE task_id = ?',
      [taskId],
    );
    return rows;
  }

  /** Every picking_task_items row — bulk fetch for the canonical adapter, grouped by task_id by the caller. */
  async findAll(): Promise<PickingTaskItemRow[]> {
    const [rows] = await this.db.query<SqlRow<PickingTaskItemRow>[]>('SELECT * FROM picking_task_items');
    return rows;
  }
}
