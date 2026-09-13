import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { BranchesModel } from "@/models/branches.model";
import { branchesService } from "@/services/branches.service";
import { successResponse, tSuccessResponse, tErrorResponse } from "@/utils";

export const branchesRoute = new Elysia({ prefix: "/branches" })
  .use(authPlugin)

  .get(
    "/",
    async () => successResponse({ result: await branchesService.list() }),
    {
      auth: ["hq", "branch"],
      response: {
        200: tSuccessResponse(
          t.Object({ result: t.Array(BranchesModel.entity) }),
        ),
      },
      detail: {
        summary: "List branches",
        description: "List all branches.",
        tags: ["Branches"],
      },
    },
  )

  .get(
    "/:id",
    async ({ params: { id } }) =>
      successResponse({ result: await branchesService.getById(id) }),
    {
      auth: ["hq", "branch"],
      params: BranchesModel.params,
      response: {
        200: tSuccessResponse(t.Object({ result: BranchesModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
      },
      detail: {
        summary: "Get a single branch",
        description: "View one branch's details.",
        tags: ["Branches"],
      },
    },
  )

  .post(
    "/",
    async ({ body }) =>
      successResponse({ result: await branchesService.create(body) }),
    {
      auth: ["hq"],
      body: BranchesModel.createBody,
      response: {
        200: tSuccessResponse(t.Object({ result: BranchesModel.entity })),
        409: tErrorResponse("ALREADY_EXISTS"),
      },
      detail: {
        summary: "Create a branch",
        description:
          "Add a new branch before users/orders/inventory can be assigned to it.",
        tags: ["Branches"],
      },
    },
  )

  .patch(
    "/:id",
    async ({ params: { id }, body }) =>
      successResponse({ result: await branchesService.update(id, body) }),
    {
      auth: ["hq"],
      params: BranchesModel.params,
      body: BranchesModel.updateBody,
      response: {
        200: tSuccessResponse(t.Object({ result: BranchesModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("ALREADY_EXISTS"),
      },
      detail: {
        summary: "Update a branch",
        description: "Edit an existing branch's details.",
        tags: ["Branches"],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params: { id } }) =>
      successResponse({ result: await branchesService.deactivate(id) }), // หรือ remove(id) ตามชื่อใน Service คุณ
    {
      auth: ["hq"],
      params: BranchesModel.params,
      response: {
        200: tSuccessResponse(t.Object({ result: BranchesModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("CATEGORY_IN_USE"),
      },
      detail: {
        summary: "Deactivate a branch",
        description: "Change isActive to false or delete branch",
        tags: ["Branches"],
      },
    },
  );
