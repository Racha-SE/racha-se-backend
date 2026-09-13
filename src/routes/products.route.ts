import { Elysia } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { ProductsModel } from "@/models/products.model";
import { productsService } from "@/services/products.service";
import {
  type UserType,
  successResponse,
  tErrorResponse,
  toActor,
  tSuccessResponse,
} from "@/utils";

// HQ, Branch, and Cashier accounts can view products.
const READ_PRODUCT_TYPES: UserType[] = ["hq", "branch", "cashier"];

// Only HQ managers can create, update, or deactivate products in the catalog.
const MANAGE_PRODUCT_TYPES: UserType[] = ["hq"];

export const productsRoute = new Elysia({ prefix: "/products" })
  .use(authPlugin)
  .get(
    "/",
    async ({ user, query }) =>
      successResponse(await productsService.list(toActor(user), query)),
    {
      auth: READ_PRODUCT_TYPES,
      query: ProductsModel.listQuery,
      response: {
        200: tSuccessResponse(ProductsModel.listResult),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "List products (searchable)",
        description: "Search/select an existing product to add to the order.",
        tags: ["Products"],
      },
    },
  )
  .get(
    "/:id",
    async ({ user, params }) =>
      successResponse(await productsService.getById(toActor(user), params.id)),
    {
      auth: READ_PRODUCT_TYPES,
      params: ProductsModel.params,
      response: {
        200: tSuccessResponse(ProductsModel.entity),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Get a single product",
        description:
          "View one product's full details before adding it to the order.",
        tags: ["Products"],
      },
    },
  )
  .post(
    "/",
    async ({ user, body }) =>
      successResponse(await productsService.create(toActor(user), body)),
    {
      auth: MANAGE_PRODUCT_TYPES,
      body: ProductsModel.createBody,
      response: {
        200: tSuccessResponse(ProductsModel.entity),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        409: tErrorResponse("ALREADY_EXISTS"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Create a product",
        description:
          "Add a new product to the catalog, standalone or inline while creating a supplier order.",
        tags: ["Products"],
      },
    },
  )
  .patch(
    "/:id",
    async ({ user, params, body }) =>
      successResponse(
        await productsService.update(toActor(user), params.id, body),
      ),
    {
      auth: MANAGE_PRODUCT_TYPES,
      params: ProductsModel.params,
      body: ProductsModel.updateBody,
      response: {
        200: tSuccessResponse(ProductsModel.entity),
        400: tErrorResponse("BAD_REQUEST"),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("ALREADY_EXISTS"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Update a product",
        description:
          "Edit product fields including minStockHq and minStockBranch, and/or replace its category links via categoryIds; existing orders keep their own snapshotted price/cost.",
        tags: ["Products"],
      },
    },
  )
  .delete(
    "/:id",
    async ({ user, params }) =>
      successResponse(
        await productsService.deactivate(toActor(user), params.id),
      ),
    {
      auth: MANAGE_PRODUCT_TYPES,
      params: ProductsModel.params,
      response: {
        200: tSuccessResponse(ProductsModel.entity),
        403: tErrorResponse("FORBIDDEN"),
        404: tErrorResponse("NOT_FOUND"),
        500: tErrorResponse("INTERNAL_SERVER_ERROR"),
      },
      detail: {
        summary: "Deactivate a product",
        description: "Change isActive to false",
        tags: ["Products"],
      },
    },
  );
