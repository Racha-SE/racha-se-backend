import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { ProductsModel } from "@/models/products.model";
import { productsService } from "@/services/products.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const productsRoute = new Elysia({ prefix: "/products" })
  .use(authPlugin)
  .get(
    "/",
    async () => successResponse({ result: await productsService.list() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List products (searchable)",
        description: "Search/select an existing product to add to the order.",
        tags: ["Products"],
      },
    },
  )
  .get(
    "/:id",
    async () => successResponse({ result: await productsService.getById() }),
    {
      auth: true, // change later
      params: ProductsModel.params,
      response: stubResponse,
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
    async () => successResponse({ result: await productsService.create() }),
    {
      auth: true, // change later
      body: ProductsModel.createBody,
      response: stubResponse,
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
    async () => successResponse({ result: await productsService.update() }),
    {
      auth: true, // change later
      params: ProductsModel.params,
      body: ProductsModel.updateBody,
      response: stubResponse,
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
    async () => successResponse({ result: await productsService.deactivate() }),
    {
      auth: true, // change later
      params: ProductsModel.params,
      response: stubResponse,
      detail: {
        summary: "Deactivate a product",
        description: "Change isActive to false",
        tags: ["Products"],
      },
    },
  );
