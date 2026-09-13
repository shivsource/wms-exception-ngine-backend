import { Pool, RowDataPacket } from 'mysql2/promise';
import { GeneralDatasetSummary } from './general-dataset';
import { ScenarioTarget } from './controlled-scenarios';

async function one(pool: Pool, sql: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql);
  return Number((rows[0] as RowDataPacket)?.c ?? 0);
}

export async function printSeedSummary(pool: Pool, t0: Date, general: GeneralDatasetSummary, targets: ScenarioTarget[]): Promise<void> {
  const lines: string[] = [];
  const line = (s = '') => lines.push(s);

  line('='.repeat(70));
  line('WMS DATASET CREATED');
  line('='.repeat(70));
  line();
  line(`Simulation time (T0): ${t0.toISOString()}`);
  line();
  line(`Customers:  ${general.customers}+`);
  line(`Products:   ${general.products}`);
  line(`Orders:     ${general.orders} (general) + ${new Set(targets.map((t) => t.entityType === 'ORDER' ? t.entityId : null).filter(Boolean)).size} (controlled)`);
  line(`Inventory:  ${general.inventory}`);
  line(`Picking:    ${general.pickingTasks} tasks / ${general.pickingTaskItems} items`);
  line(`Packing:    ${general.packing}`);
  line(`Dispatch:   ${general.dispatch}`);
  line(`Returns:    ${general.returns}`);
  line();
  line('Orders by state (general dataset):');
  for (const [status, cnt] of Object.entries(general.ordersByStatus)) line(`  ${status.padEnd(20)} ${cnt}`);
  line();

  const [slaRows] = await pool.query<RowDataPacket[]>(
    `SELECT
       SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, NOW(), expected_dispatch) >= 121 THEN 1 ELSE 0 END) healthy,
       SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, NOW(), expected_dispatch) BETWEEN 46 AND 120 THEN 1 ELSE 0 END) moderate,
       SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, NOW(), expected_dispatch) BETWEEN 16 AND 45 THEN 1 ELSE 0 END) high,
       SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, NOW(), expected_dispatch) BETWEEN 1 AND 15 THEN 1 ELSE 0 END) critical,
       SUM(CASE WHEN TIMESTAMPDIFF(MINUTE, NOW(), expected_dispatch) <= 0 THEN 1 ELSE 0 END) breached,
       COUNT(*) total
     FROM orders WHERE status NOT IN ('DISPATCHED','CANCELLED') AND order_id NOT LIKE 'VAL-%'`,
  );
  const sla = slaRows[0] as RowDataPacket;
  line('SLA distribution (open, non-controlled orders, measured live):');
  line(`  Healthy (>=121min):     ${sla.healthy}`);
  line(`  Moderate (46-120min):   ${sla.moderate}`);
  line(`  High risk (16-45min):   ${sla.high}`);
  line(`  Critical (1-15min):     ${sla.critical}`);
  line(`  Already breached:       ${sla.breached}`);
  line(`  Total open:             ${sla.total}`);
  line();

  const uniqueScenarios = new Set(targets.map((t) => t.scenarioId)).size;
  line(`Controlled validation scenarios: ${uniqueScenarios} (targets: ${targets.length})`);
  const byResult: Record<string, string[]> = {};
  for (const t of targets) (byResult[t.expectedResult] ??= []).push(t.scenarioId);
  for (const [result, ids] of Object.entries(byResult)) line(`  ${result.padEnd(28)} ${[...new Set(ids)].join(', ')}`);
  line();

  const openExceptions = await one(pool, "SELECT COUNT(*) c FROM exceptions WHERE status = 'OPEN'");
  const totalPredictions = await one(pool, 'SELECT COUNT(*) c FROM predictions');
  line(`Currently OPEN exceptions (whole dataset): ${openExceptions}`);
  line(`Currently persisted predictions (whole dataset): ${totalPredictions}`);
  line('='.repeat(70));

  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}
