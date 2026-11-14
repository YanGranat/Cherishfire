/** Keep automatically allocated row identities exactly representable in JS. */
export function generatedIdCapacitySql(
  table: "habits" | "day_records" | "notes",
): string {
  return `(
    COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${table}'), 0) < ${Number.MAX_SAFE_INTEGER}
    AND COALESCE((SELECT MAX(id) FROM ${table}), 0) < ${Number.MAX_SAFE_INTEGER}
  )`;
}
