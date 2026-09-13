/** Whole minutes elapsed from `earlier` to `later` (negative if `later` is actually before `earlier`). */
export function minutesBetween(earlier: Date, later: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 60000);
}
