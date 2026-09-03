import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { CategoriesModel } from "@/models/categories.model";
import { categoriesService } from "@/services/categories.service";
import { successResponse, tErrorResponse, tSuccessResponse } from "@/utils";

const stubResponse = {
  200: tSuccessResponse(t.Object({ result: t.Null() })),
  500: tErrorResponse("INTERNAL_SERVER_ERROR"),
};

export const categoriesRoute = new Elysia({ prefix: "/categories" })
  .use(authPlugin)
  .get(
    "/",
    async () => successResponse({ result: await categoriesService.list() }),
    {
      auth: true, // change later
      response: stubResponse,
      detail: {
        summary: "List categories",
        description:
          "List all product categories, optionally filtered by name.",
        tags: ["Categories"],
      },
    },
  )
  .get(
    "/:id",
    async () => successResponse({ result: await categoriesService.getById() }),
    {
      auth: true, // change later
      params: CategoriesModel.params,
      response: stubResponse,
      detail: {
        summary: "Get a single category",
        description: "View one category's details.",
        tags: ["Categories"],
      },
    },
  )
  .post(
    "/",
    async () => successResponse({ result: await categoriesService.create() }),
    {
      auth: true, // change later
      body: CategoriesModel.createBody,
      response: stubResponse,
      detail: {
        summary: "Create a category",
        description:
          "Add a new product category, standalone or inline while creating a product (also used from US-2.2).",
        tags: ["Categories"],
      },
    },
  )
  .patch(
    "/:id",
    async () => successResponse({ result: await categoriesService.update() }),
    {
      auth: true, // change later
      params: CategoriesModel.params,
      body: CategoriesModel.updateBody,
      response: stubResponse,
      detail: {
        summary: "Update a category",
        description: "Rename an existing category.",
        tags: ["Categories"],
      },
    },
  )
  .delete(
    "/:id",
    async () => successResponse({ result: await categoriesService.remove() }),
    {
      auth: true, // change later
      params: CategoriesModel.params,
      response: stubResponse,
      detail: {
        summary: "Delete a category",
        description:
          "Delete a category; rejected with CATEGORY_IN_USE if products are still mapped to it.",
        tags: ["Categories"],
      },
    },
  );
