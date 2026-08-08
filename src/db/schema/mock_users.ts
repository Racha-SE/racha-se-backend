import { pgTable, text, uuid } from "drizzle-orm/pg-core";

// mock_users backs the /mock/users reference route only (src/routes/mock.route.ts,
// src/services/user.service.ts) — kept separate from the real `user` table so
// the demo route never touches real business data.
export const mockUsersTable = pgTable("mock_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
});
