import { Elysia, t } from "elysia";
import { UserModel } from "@/models/mock-users.model";
import { userService } from "@/services/user.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

export const mockRoute = new Elysia({ prefix: "/mock/users" })
  .get(
    "/",
    async () => successResponse({ users: await userService.findAll() }),
    {
      response: {
        200: tSuccessResponse(t.Object({ users: t.Array(UserModel.entity) })),
      },
      detail: {
        summary: "List mock users",
        description:
          "Dev-only reference implementation of the model/service/route pattern.",
        tags: ["Mock"],
      },
    },
  )
  .get(
    "/:id",
    async ({ params }) =>
      successResponse(await userService.findById(params.id)),
    {
      params: UserModel.params,
      response: {
        200: tSuccessResponse(UserModel.entity),
        404: tErrorResponse("NOT_FOUND"),
      },
      detail: {
        summary: "Get a mock user",
        description: "Dev-only.",
        tags: ["Mock"],
      },
    },
  )
  .post(
    "/",
    async ({ body }) => successResponse(await userService.create(body.name)),
    {
      body: UserModel.createBody,
      response: {
        200: tSuccessResponse(UserModel.entity),
        409: tErrorResponse("ALREADY_EXISTS"),
      },
      detail: {
        summary: "Create a mock user",
        description: "Dev-only. Name must be unique.",
        tags: ["Mock"],
      },
    },
  );
