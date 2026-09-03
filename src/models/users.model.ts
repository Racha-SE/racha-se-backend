import { type Static, t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { user, userTypeEnum } from "@/db/schema";

const entity = createSelectSchema(user);
const insertSchema = createInsertSchema(user);

// `name` is intentionally excluded — the route derives it from
// firstname/lastname (see scripts/create-admin.ts, which does the same)
// rather than making callers supply a redundant display name.
const profileBody = t.Omit(insertSchema, [
  "id",
  "name",
  "emailVerified",
  "role",
  "banned",
  "banReason",
  "banExpires",
  "createdAt",
  "updatedAt",
]);

const userTypeSchema = t.Union(
  userTypeEnum.enumValues.map((value) => t.Literal(value)),
);

export const UsersModel = {
  entity,
  params: t.Object({ id: t.String() }),
  listQuery: t.Object({
    branchId: t.Optional(t.Numeric()),
    userType: t.Optional(userTypeSchema),
    search: t.Optional(t.String()),
    limit: t.Optional(t.Numeric()),
    offset: t.Optional(t.Numeric()),
  }),
  listResult: t.Object({
    users: t.Array(entity),
    total: t.Number(),
    page: t.Number(),
    totalPages: t.Number(),
    limit: t.Number(),
    offset: t.Number(),
  }),
  createBody: t.Composite([
    profileBody,
    t.Object({ password: t.String({ minLength: 8 }) }),
  ]),
  updateBody: t.Partial(
    t.Pick(profileBody, [
      "firstname",
      "lastname",
      "username",
      "birthdate",
      "branchId",
      "image",
    ]),
  ),
};

export type User = Static<typeof UsersModel.entity>;
export type ListUsersQuery = Static<typeof UsersModel.listQuery>;
export type ListUsersResult = Static<typeof UsersModel.listResult>;
export type CreateUserBody = Static<typeof UsersModel.createBody>;
export type UpdateUserBody = Static<typeof UsersModel.updateBody>;
