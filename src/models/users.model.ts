import { t } from "elysia";
import { createInsertSchema } from "drizzle-typebox";
import { user } from "@/db/schema";

const insertSchema = createInsertSchema(user);
const profileBody = t.Omit(insertSchema, [
  "id",
  "emailVerified",
  "role",
  "banned",
  "banReason",
  "banExpires",
  "createdAt",
  "updatedAt",
]);

export const UsersModel = {
  params: t.Object({ id: t.String() }),
  createBody: t.Composite([
    profileBody,
    t.Object({ password: t.String({ minLength: 8 }) }),
  ]),
};
