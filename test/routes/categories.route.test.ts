import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "@/db/client";
import {
  product,
  productCategory,
  productCategoryMap,
  user,
} from "@/db/schema";
import type { Category } from "@/models/categories.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, categoriesRoute } from "@/routes";
import { auth } from "@/utils";

// Same composition as the real app (src/index.ts), minus the dev-only gate
// and the /api/v1 grouping — authRoute for real sign-in, errorHandler +
// categoriesRoute (which pulls in authPlugin itself) for the API under test.
const app = new Elysia().use(authRoute).use(errorHandler).use(categoriesRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

const createdUserIds: string[] = [];
const createdCategoryIds: number[] = [];
const createdProductIds: number[] = [];
let hqCookie: string;

async function createSignedInHqUser() {
  const email = `categories-route-test-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  const result = await auth.api.createUser({
    body: {
      email,
      password,
      name: "Categories Route Test",
      data: {
        userType: "hq",
        firstname: "Categories",
        lastname: "Test",
        username: `categoriesroutetest${crypto.randomUUID()}`,
      },
    },
  });
  createdUserIds.push(result.user.id);

  const signInResponse = await app.handle(
    new Request("http://localhost/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );

  return signInResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function authHeaders(cookie: string): HeadersInit {
  return { Cookie: cookie, "Content-Type": "application/json" };
}

function uniqueName() {
  return `Categories Test ${crypto.randomUUID()}`;
}

async function postCategory(categoryName: string) {
  const response = await app.handle(
    new Request("http://localhost/categories", {
      method: "POST",
      headers: authHeaders(hqCookie),
      body: JSON.stringify({ categoryName }),
    }),
  );
  if (response.status === 200) {
    const body = (await response.clone().json()) as SuccessBody<{
      result: Category;
    }>;
    createdCategoryIds.push(body.data.result.categoryId);
  }

  return response;
}

async function deleteCategory(categoryId: number) {
  return await app.handle(
    new Request(`http://localhost/categories/${categoryId}`, {
      method: "DELETE",
      headers: authHeaders(hqCookie),
    }),
  );
}

beforeAll(async () => {
  hqCookie = await createSignedInHqUser();
});

afterAll(async () => {
  if (createdProductIds.length > 0) {
    await db
      .delete(productCategoryMap)
      .where(inArray(productCategoryMap.pId, createdProductIds));
    await db.delete(product).where(inArray(product.pId, createdProductIds));
  }
  if (createdCategoryIds.length > 0) {
    await db
      .delete(productCategory)
      .where(inArray(productCategory.categoryId, createdCategoryIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(user).where(inArray(user.id, createdUserIds));
  }
});

describe("DELETE /categories/:id", () => {
  test("deletes a category no product uses", async () => {
    const created = (await (
      await postCategory(uniqueName())
    ).json()) as SuccessBody<{ result: Category }>;

    const response = await deleteCategory(created.data.result.categoryId);

    expect(response.status).toBe(200);
  });

  test("returns 409 CATEGORY_IN_USE (not a 500) while a product is mapped to it", async () => {
    const created = (await (
      await postCategory(uniqueName())
    ).json()) as SuccessBody<{ result: Category }>;
    const { categoryId } = created.data.result;

    const [linkedProduct] = await db
      .insert(product)
      .values({
        name: `Categories Test Product ${crypto.randomUUID()}`,
        barcode: crypto.randomUUID(),
      })
      .returning({ pId: product.pId });
    createdProductIds.push(linkedProduct.pId);
    await db
      .insert(productCategoryMap)
      .values({ pId: linkedProduct.pId, categoryId });

    const response = await deleteCategory(categoryId);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CATEGORY_IN_USE");

    const [stillThere] = await db
      .select()
      .from(productCategory)
      .where(eq(productCategory.categoryId, categoryId));
    expect(stillThere).toBeDefined();
  });
});

describe("POST /categories", () => {
  test("returns 409 ALREADY_EXISTS for a duplicate name", async () => {
    const categoryName = uniqueName();
    expect((await postCategory(categoryName)).status).toBe(200);

    const response = await postCategory(categoryName);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("ALREADY_EXISTS");
  });
});
