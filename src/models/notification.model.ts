import { t } from "elysia";
import { createSelectSchema } from "drizzle-typebox";
import { notification } from "@/db/schema";

const entity = createSelectSchema(notification);

export const NotificationModel = {
  entity,
  branchParams: t.Object({ branchId: t.String() }),
};
