import { Elysia, t } from "elysia";
import { UserModel } from "@/models/user.model";
import { userService } from "@/services/user.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

export const mockRoute = new Elysia({ prefix: "/mock/users" })
  .get("/", () => successResponse({ users: userService.findAll() }), {
    response: {
      200: tSuccessResponse(t.Object({ users: t.Array(UserModel.entity) })),
    },
  })
  .get(
    "/:id",
    ({ params }) => successResponse(userService.findById(params.id)),
    {
      params: UserModel.params,
      response: {
        200: tSuccessResponse(UserModel.entity),
        404: tErrorResponse("NOT_FOUND"),
      },
    },
  )
  .post("/", ({ body }) => successResponse(userService.create(body.name)), {
    body: UserModel.createBody,
    response: {
      200: tSuccessResponse(UserModel.entity),
      409: tErrorResponse("ALREADY_EXISTS"),
    },
  });
