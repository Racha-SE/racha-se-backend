import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { UsersModel } from "@/models/users.model";
import { usersService } from "@/services/users.service";
import { successResponse, tSuccessResponse } from "@/utils";

const stubResponse = { 200: tSuccessResponse(t.Object({ result: t.Null() })) };

export const usersRoute = new Elysia({ prefix: "/users" })
  .use(authPlugin)
  .get(
    "/",
    async () => successResponse({ result: await usersService.list() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List users within the caller's authorized scope",
        description:
          "HQ Admin sees users across all branches; Branch User sees only users in their own branch.",
        tags: ["Users"],
      },
    },
  )
  .get(
    "/:id",
    async () => successResponse({ result: await usersService.getById() }),
    {
      auth: true, // change later
      params: UsersModel.params,
      response: stubResponse,
      detail: {
        summary: "Get a single user",
        description:
          "View one user account's details, within the caller's authorized scope.",
        tags: ["Users"],
      },
    },
  )
  .post(
    "/",
    async () => successResponse({ result: await usersService.create() }),
    {
      auth: true, // change later
      body: UsersModel.createBody,
      response: stubResponse,
      detail: {
        summary: "Create a new user account (hierarchy-checked)",
        description:
          "Custom route replacing disabled public sign-up; checks the caller's userType hierarchy before creating the account via better-auth.",
        tags: ["Users"],
      },
    },
  )
  .delete(
    "/:id",
    async () => successResponse({ result: await usersService.deactivate() }),
    {
      auth: true, // change later
      params: UsersModel.params,
      response: stubResponse,
      detail: {
        summary: "Deactivate a user account",
        description:
          "Checks hierarchy, then calls better-auth's admin.banUser() - better-auth blocks sign-in and kills existing sessions natively, no custom isActive field needed.",
        tags: ["Users"],
      },
    },
  );
