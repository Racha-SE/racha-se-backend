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

const sortDirection = t.Union([t.Literal("asc"), t.Literal("desc")]);

export const UsersModel = {
  entity,
  params: t.Object({ id: t.String() }),
  listQuery: t.Partial(
    t.Object({
      branchId: t.Numeric(),
      userType: userTypeSchema,
      search: t.String(),
      status: t.Union([t.Literal("active"), t.Literal("inactive")]),
      // Separate from `userType` on purpose — "root" in the frontend's filter
      // means better-auth's `role` column (admin/user), not the business
      // `userType`, so it needs its own query param rather than overloading
      // userType with a value that isn't actually one of its enum members.
      isRoot: t.Boolean(),
      // One optional param per sortable column, applied id > username > email
      // > branch when more than one is set — matches the frontend's existing
      // multi-column sort priority exactly, so paginating server-side doesn't
      // change what order columns win when several are toggled at once.
      sortId: sortDirection,
      sortUsername: sortDirection,
      sortEmail: sortDirection,
      sortBranch: sortDirection,
      limit: t.Numeric(),
      offset: t.Numeric(),
    }),
  ),
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
