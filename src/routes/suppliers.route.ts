import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { SuppliersModel } from "@/models/suppliers.model";
import { suppliersService } from "@/services/suppliers.service";
import {
  type UserType,
  successResponse,
  tErrorResponse,
  tSuccessResponse,
} from "@/utils";

// Suppliers are reference data HQ uses while creating a supplier (HQ) order
// (see orders-hq.route.ts, hq-only) — no other userType deals with them.
const READ_SUPPLIER_TYPES: UserType[] = ["hq"];

export const suppliersRoute = new Elysia({ prefix: "/suppliers" })
  .use(authPlugin)
  .get(
    "/",
    async () => successResponse({ result: await suppliersService.list() }),
    {
      auth: READ_SUPPLIER_TYPES,
      response: {
        200: tSuccessResponse(
          t.Object({ result: t.Array(SuppliersModel.entity) }),
        ),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List suppliers",
        description: "Reference data used while creating a supplier order.",
        tags: ["Suppliers"],
      },
    },
  )
  .get(
    "/:id",
    async ({ params: { id } }) =>
      successResponse({ result: await suppliersService.getById(id) }),
    {
      auth: READ_SUPPLIER_TYPES,
      params: SuppliersModel.params,
      response: {
        200: tSuccessResponse(t.Object({ result: SuppliersModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Get a single supplier",
        description: "View one supplier's details.",
        tags: ["Suppliers"],
      },
    },
  );
