/**
 * Points table logic: finishing positions (1-based) map to points via a
 * configurable comma-separated table. Positions beyond the table get 0.
 */

export const DEFAULT_POINTS_TABLE = "100,75,55,40,30,20,12,8,5,3";

export function parsePointsTable(raw: string | undefined | null): number[] {
  const src = (raw ?? "").trim() || DEFAULT_POINTS_TABLE;
  const vals = src
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (vals.length === 0) {
    throw new Error(`Invalid POINTS_TABLE: "${raw}"`);
  }
  return vals;
}

export function pointsForPosition(table: number[], position: number): number {
  if (!Number.isInteger(position) || position < 1) return 0;
  return table[position - 1] ?? 0;
}
