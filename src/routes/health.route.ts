import { Elysia, t } from "elysia";
import { successResponse, tSuccessResponse } from "@/utils";

export const healthRoute = new Elysia().get(
  "/health",
  () => successResponse({ status: "ok" as const }),
  {
    response: {
      200: tSuccessResponse(t.Object({ status: t.Literal("ok") })),
    },
  },
);
