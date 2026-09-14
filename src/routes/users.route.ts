import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { UsersModel } from "@/models/users.model";
import { usersService } from "@/services/users.service";
import {
  type UserType,
  successResponse,
  tErrorResponse,
  toActor,
  tSuccessResponse,
} from "@/utils";

// Only hq and branch accounts manage other accounts — cashier/customer never
// reach any handler below (authPlugin's macro 403s them first).
const MANAGER_USER_TYPES: UserType[] = ["hq", "branch"];

export const usersRoute = new Elysia({ prefix: "/users" })
  .use(authPlugin)
  .get(
    "/",
    async ({ user, query }) =>
      successResponse(await usersService.list(toActor(user), query)),
    {
      auth: MANAGER_USER_TYPES,
      query: UsersModel.listQuery,
      response: {
        200: tSuccessResponse(UsersModel.listResult),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
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
    async ({ user, params }) =>
      successResponse(await usersService.getById(toActor(user), params.id)),
    {
      auth: MANAGER_USER_TYPES,
      params: UsersModel.params,
      response: {
        200: tSuccessResponse(UsersModel.entity),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Get a single user",
        description:
          "View one user account's details, within the caller's authorized scope.",
        tags: ["Users"],
      },
    },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) =>
      successResponse(
        await usersService.update(toActor(user), params.id, body),
      ),
    {
      auth: MANAGER_USER_TYPES,
      params: UsersModel.params,
      body: UsersModel.updateBody,
      response: {
        200: tSuccessResponse(UsersModel.entity),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("ALREADY_EXISTS"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Update a user",
        description:
          "Edit an existing user's profile fields, within the caller's authorized scope.",
        tags: ["Users"],
      },
    },
  )
  .post(
    "/",
    async ({ user, body }) =>
      successResponse(await usersService.create(toActor(user), body)),
    {
      auth: MANAGER_USER_TYPES,
      body: UsersModel.createBody,
      response: {
        200: tSuccessResponse(UsersModel.entity),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        409: tErrorResponse("ALREADY_EXISTS"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Create a new user account (hierarchy-checked)",
        description:
          "Custom route replacing disabled public sign-up; checks the caller's userType hierarchy before creating the account via better-auth. HQ may create hq/branch/cashier/customer accounts; a Branch account may only create cashiers within its own branch.",
        tags: ["Users"],
      },
    },
  )
  .patch(
    "/:id/deactivate",
    async ({ user, params }) =>
      successResponse(await usersService.deactivate(toActor(user), params.id)),
    {
      auth: MANAGER_USER_TYPES,
      params: UsersModel.params,
      response: {
        200: tSuccessResponse(UsersModel.entity),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Deactivate a user account",
        description:
          "Checks hierarchy, then bans the account (blocks sign-in, kills existing sessions) — no custom isActive field needed.",
        tags: ["Users"],
      },
    },
  )
  .patch(
    "/:id/reactivate",
    async ({ user, params }) =>
      successResponse(await usersService.reactivate(toActor(user), params.id)),
    {
      auth: MANAGER_USER_TYPES,
      params: UsersModel.params,
      response: {
        200: tSuccessResponse(UsersModel.entity),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Reactivate a deactivated user account",
        description:
          "Checks hierarchy, then clears banned/banReason/banExpires, restoring the account's ability to sign in.",
        tags: ["Users"],
      },
    },
  );
