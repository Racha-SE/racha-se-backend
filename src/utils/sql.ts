import { sql } from "drizzle-orm";

export function utcTimestamp(value: Date) {
  return sql`${value.toISOString()}::timestamp`;
}
