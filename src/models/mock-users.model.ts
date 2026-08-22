import { type Static, t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { mockUsersTable } from "@/db/schema";

const entity = createSelectSchema(mockUsersTable);
const insertSchema = createInsertSchema(mockUsersTable);

export const UserModel = {
  entity,
  params: t.Pick(entity, ["id"]),
  createBody: t.Pick(insertSchema, ["name"]),
};

export type User = Static<typeof UserModel.entity>;
export type CreateUserBody = Static<typeof UserModel.createBody>;
