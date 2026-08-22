import { type Static, t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { branch } from "@/db/schema";

const entity = createSelectSchema(branch);
const insertSchema = createInsertSchema(branch);
const body = t.Omit(insertSchema, ["branchId", "createdAt", "updatedAt"]);

export const BranchesModel = {
  entity,
  params: t.Object({ id: t.Numeric() }),
  createBody: body,
  updateBody: t.Partial(body),
};

export type Branch = Static<typeof BranchesModel.entity>;
export type CreateBranchBody = Static<typeof BranchesModel.createBody>;
export type UpdateBranchBody = Static<typeof BranchesModel.updateBody>;
