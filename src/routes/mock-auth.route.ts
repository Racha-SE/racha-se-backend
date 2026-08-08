import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { successResponse, tSuccessResponse } from "@/utils";

// demonstrates src/plugins/auth.plugin.ts's `auth` macro — dev-only (gated
// in src/index.ts, same as mock.route.ts). Not real product code.
export const mockAuthRoute = new Elysia({ prefix: "/mock/auth" })
  .use(authPlugin)
  .get(
    "/me",
    ({ user }) =>
      successResponse({
        id: user.id,
        email: user.email,
        userType: user.userType,
      }),
    {
      auth: true,
      response: {
        200: tSuccessResponse(
          t.Object({
            id: t.String(),
            email: t.String(),
            userType: t.String(),
          }),
        ),
      },
      detail: {
        summary: "Get current user",
        description:
          "Dev-only. Demonstrates the auth macro — any signed-in user, regardless of userType.",
        tags: ["Mock Auth"],
      },
    },
  )
  .get(
    "/hq-only",
    ({ user }) =>
      successResponse({ message: `Welcome, HQ user ${user.username}` }),
    {
      auth: ["hq"],
      response: {
        200: tSuccessResponse(t.Object({ message: t.String() })),
      },
      detail: {
        summary: "HQ-only endpoint",
        description:
          'Dev-only. Demonstrates userType-gated authorization — only userType "hq" is allowed, 403 otherwise.',
        tags: ["Mock Auth"],
      },
    },
  );
