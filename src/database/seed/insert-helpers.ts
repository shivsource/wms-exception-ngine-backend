import { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** Bulk INSERT in chunks (MySQL's multi-row VALUES syntax via mysql2's array-of-arrays form). */
export async function bulkInsert(pool: Pool, table: string, columns: string[], rows: unknown[][], chunkSize = 500): Promise<void> {
  if (rows.length === 0) return;
  const sql = `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES ?`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await pool.query<ResultSetHeader>(sql, [chunk]);
  }
}

/** Maps a business code column back to its numeric auto-increment id, for FK linking. */
export async function loadCodeToIdMap(pool: Pool, table: string, codeColumn: string): Promise<Map<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT id, \`${codeColumn}\` AS code FROM \`${table}\``);
  return new Map(rows.map((r) => [r.code as string, r.id as number]));
}
