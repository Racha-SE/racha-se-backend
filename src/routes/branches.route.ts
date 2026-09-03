import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { BranchesModel } from "@/models/branches.model";
import { branchesService } from "@/services/branches.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const branchesRoute = new Elysia({ prefix: "/branches" })
  .use(authPlugin)
  .get(
    "/",
    async () => successResponse({ result: await branchesService.list() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List branches",
        description: "List all branches.",
        tags: ["Branches"],
      },
    },
  )
  .get(
    "/:id",
    async () => successResponse({ result: await branchesService.getById() }),
    {
      auth: true, // change later
      params: BranchesModel.params,
      response: stubResponse,
      detail: {
        summary: "Get a single branch",
        description: "View one branch's details.",
        tags: ["Branches"],
      },
    },
  )
  .post(
    "/",
    async () => successResponse({ result: await branchesService.create() }),
    {
      auth: true, // change later
      body: BranchesModel.createBody,
      response: stubResponse,
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
    async () => successResponse({ result: await branchesService.update() }),
    {
      auth: true, // change later
      params: BranchesModel.params,
      body: BranchesModel.updateBody,
      response: stubResponse,
      detail: {
        summary: "Update a branch",
        description: "Edit an existing branch's details.",
        tags: ["Branches"],
      },
    },
  )
  .delete(
    "/:id",
    async () => successResponse({ result: await branchesService.deactivate() }),
    {
      auth: true, // change later
      params: BranchesModel.params,
      response: stubResponse,
      detail: {
        summary: "Deactivate a branch",
        description: "Change isActive to false",
        tags: ["Branches"],
      },
    },
  );
