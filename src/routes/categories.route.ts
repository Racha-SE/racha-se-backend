import { Elysia, t } from "elysia";
import { authPlugin } from "@/plugins/auth.plugin";
import { CategoriesModel } from "@/models/categories.model";
import { categoriesService } from "@/services/categories.service";
import { successResponse, tSuccessResponse, tErrorResponse } from "@/utils";

export const categoriesRoute = new Elysia({ prefix: "/categories" })
  .use(authPlugin)

  .get(
    "/",
    async () => successResponse({ result: await categoriesService.list() }),
    {
      auth: ["hq", "branch"],
      response: {
        200: tSuccessResponse(
          t.Object({ result: t.Array(CategoriesModel.entity) }),
        ),
      },
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
    async ({ params: { id } }) =>
      successResponse({ result: await categoriesService.getById(id) }),
    {
      auth: ["hq", "branch"],
      params: CategoriesModel.params,
      response: {
        200: tSuccessResponse(t.Object({ result: CategoriesModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
      },
      detail: {
        summary: "Get a single category",
        description: "View one category's details.",
        tags: ["Categories"],
      },
    },
  )

  .post(
    "/",
    async ({ body }) =>
      successResponse({ result: await categoriesService.create(body) }),
    {
      auth: ["hq"],
      body: CategoriesModel.createBody,
      response: {
        200: tSuccessResponse(t.Object({ result: CategoriesModel.entity })),
        409: tErrorResponse("ALREADY_EXISTS"),
      },
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
    async ({ params: { id }, body }) =>
      successResponse({ result: await categoriesService.update(id, body) }),
    {
      auth: ["hq"],
      params: CategoriesModel.params,
      body: CategoriesModel.updateBody,
      response: {
        200: tSuccessResponse(t.Object({ result: CategoriesModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("ALREADY_EXISTS"),
      },
      detail: {
        summary: "Update a category",
        description: "Rename an existing category.",
        tags: ["Categories"],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params: { id } }) =>
      successResponse({ result: await categoriesService.remove(id) }),
    {
      auth: ["hq"],
      params: CategoriesModel.params,
      response: {
        200: tSuccessResponse(t.Object({ result: CategoriesModel.entity })),
        404: tErrorResponse("NOT_FOUND"),
        409: tErrorResponse("CATEGORY_IN_USE"),
      },
      detail: {
        summary: "Delete a category",
        description:
          "Delete a category; rejected with CATEGORY_IN_USE if products are still mapped to it.",
        tags: ["Categories"],
      },
    },
  );
