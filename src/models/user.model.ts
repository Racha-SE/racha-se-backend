import { type Static, t } from "elysia";

export const UserModel = {
  entity: t.Object({
    id: t.String(),
    name: t.String(),
  }),

  params: t.Object({
    id: t.String(),
  }),

  createBody: t.Object({
    name: t.String(),
  }),
};

export type User = Static<typeof UserModel.entity>;
export type CreateUserBody = Static<typeof UserModel.createBody>;
