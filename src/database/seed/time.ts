/**
 * Resolves T0 for the seed run. Defaults to real wall-clock "now" (rounded down to the
 * minute) — deliberately NOT a fixed constant — because the live engines evaluate against
 * `new Date()` and are not clock-injectable; anchoring to a fixed past/future instant would
 * only reproduce the exact staleness bug this seed exists to fix the moment real time moves
 * past it. Set SIMULATION_TIME only for a one-off deterministic snapshot; see env.ts.
 */
export function resolveSimulationTime(): Date {
  const override = process.env.SIMULATION_TIME;
  if (override) {
    const d = new Date(override);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid SIMULATION_TIME: ${override}`);
    return d;
  }
  const now = new Date();
  now.setSeconds(0, 0);
  return now;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function toSql(date: Date): string {
  // MySQL DATETIME literal, UTC — matches how the existing dataset stores everything (no
  // timezone column in the schema; the whole app treats Date as an instant in UTC).
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
