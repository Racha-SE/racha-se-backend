import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { SuppliersModel } from "@/models/suppliers.model";
import { suppliersService } from "@/services/suppliers.service";
import { successResponse, tSuccessResponse } from "@/utils";

const stubResponse = { 200: tSuccessResponse(t.Object({ result: t.Null() })) };

export const suppliersRoute = new Elysia({ prefix: "/suppliers" })
  .use(authPlugin)
  .get(
    "/",
    async () => successResponse({ result: await suppliersService.list() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List suppliers",
        description: "Reference data used while creating a supplier order.",
        tags: ["Suppliers"],
      },
    },
  )
  .get(
    "/:id",
    async () => successResponse({ result: await suppliersService.getById() }),
    {
      auth: true, // change later
      params: SuppliersModel.params,
      response: stubResponse,
      detail: {
        summary: "Get a single supplier",
        description: "View one supplier's details.",
        tags: ["Suppliers"],
      },
    },
  );
