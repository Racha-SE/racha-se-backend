// Wipes EVERY table — branch, user, and better-auth's own session/account/
// verification included, not just the catalog/order tables seed-demo.ts and
// seed-demo-scale.ts touch. Those two scripts are deliberately idempotent on
// branches/users (reused across runs); this script is the opposite — a full
// "start over" reset, for when the DB has drifted (stale test accounts,
// broken sessions, whatever) and reseeding on top of it isn't enough.
//
// Not meant to be part of the normal demo-refresh loop — run it once, then
// bun run db:seed:demo:scale (or db:seed:demo) on a clean slate.
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset the database with NODE_ENV=production.");
  process.exit(1);
}

// Every table in src/db/schema/ — order doesn't matter, Postgres resolves
// FKs correctly as long as every referencing *and* referenced table is in
// the same TRUNCATE statement.
const TABLES = [
  "notification",
  "customer_order_detail",
  "branch_order_detail",
  "head_order_detail",
  "order",
  "product_category_map",
  "product",
  "product_category",
  "supplier",
  "branch",
  "session",
  "account",
  "verification",
  "user",
  "mock_users",
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// e.g. "postgres://postgres:postgres@localhost:6969/racha_se" -> "racha_se"
const dbName = databaseUrl.split("/").pop()?.split("?")[0];
if (!dbName) {
  console.error(
    `Couldn't parse a database name out of DATABASE_URL: ${databaseUrl}`,
  );
  process.exit(1);
}

console.log("This permanently deletes ALL data in every table below:");
for (const table of TABLES) console.log(`  - ${table}`);
console.log(`\nDatabase: ${databaseUrl}`);
console.log(
  "\nThis is NOT the same as db:seed:demo / db:seed:demo:scale — those keep " +
    "branches and users across runs. This deletes those too, along with " +
    "every active session (everyone currently signed in gets logged out).",
);

const confirmation = prompt(
  `\nType the database name (${dbName}) to confirm, anything else cancels:\n> `,
);

if (confirmation?.trim() !== dbName) {
  console.log("Cancelled — input didn't match. Nothing was deleted.");
  process.exit(1);
}

console.log("\nConfirmed. Wiping every table...");
await db.execute(
  sql.raw(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY`,
  ),
);

console.log("Done — every table is now empty.");
process.exit(0);
