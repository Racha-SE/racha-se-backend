import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { eq, inArray, max } from "drizzle-orm";
import { db } from "@/db/client";
import {
  branch,
  product,
  productCategory,
  productCategoryMap,
  user,
} from "@/db/schema";
import type { Product, ProductCategoryRef } from "@/models/products.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, productsRoute } from "@/routes";
import { auth, type UserType } from "@/utils";

// Same composition as the real app (src/index.ts), minus the dev-only gate
// and the /api/v1 grouping — authRoute for real sign-in, errorHandler +
// productsRoute (which pulls in authPlugin itself) for the API under test.
const app = new Elysia().use(authRoute).use(errorHandler).use(productsRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

const createdUserIds: string[] = [];
const createdProductIds: number[] = [];
const createdCategoryIds: number[] = [];
let testBranchId: number;
// Prefixed so they sort the same under any collation: "aaa" before "zzz".
let firstCategory: ProductCategoryRef;
let secondCategory: ProductCategoryRef;
let hqCookie: string;
let cashierCookie: string;
let customerCookie: string;

async function createSignedInUser(userType: UserType, branchId?: number) {
  const email = `products-route-test-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  const result = await auth.api.createUser({
    body: {
      email,
      password,
      name: "Products Route Test",
      data: {
        userType,
        firstname: "Products",
        lastname: "Test",
        username: `productsroutetest${crypto.randomUUID()}`,
        branchId,
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

function productBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `Test Product ${crypto.randomUUID()}`,
    barcode: crypto.randomUUID(),
    description: "A product used for route tests",
    minStockHq: 5,
    minStockBranch: 2,
    costPrice: 1000,
    isActive: true,
    ...overrides,
  };
}

async function createProduct(
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await app.handle(
    new Request("http://localhost/products", {
      method: "POST",
      headers: authHeaders(cookie),
      body: JSON.stringify(productBody(overrides)),
    }),
  );

  if (response.status === 200) {
    const parsed = (await response.clone().json()) as SuccessBody<Product>;
    createdProductIds.push(parsed.data.pId);
  }

  return response;
}

async function createCategory(prefix: string): Promise<ProductCategoryRef> {
  const [created] = await db
    .insert(productCategory)
    .values({ categoryName: `${prefix} Products Test ${crypto.randomUUID()}` })
    .returning({
      categoryId: productCategory.categoryId,
      categoryName: productCategory.categoryName,
    });
  createdCategoryIds.push(created.categoryId);

  return created;
}

async function patchProduct(pId: number, body: Record<string, unknown>) {
  return await app.handle(
    new Request(`http://localhost/products/${pId}`, {
      method: "PATCH",
      headers: authHeaders(hqCookie),
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  firstCategory = await createCategory("aaa");
  secondCategory = await createCategory("zzz");

  const [createdBranch] = await db
    .insert(branch)
    .values({
      name: `Products Test Branch ${crypto.randomUUID()}`,
      address: "123 Test St",
      phoneNumber: "0000000000",
    })
    .returning();
  testBranchId = createdBranch.branchId;

  hqCookie = await createSignedInUser("hq");
  cashierCookie = await createSignedInUser("cashier", testBranchId);
  customerCookie = await createSignedInUser("customer");
});

afterAll(async () => {
  if (createdProductIds.length > 0) {
    // category links reference the product, so they go first
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
  if (testBranchId !== undefined) {
    await db.delete(branch).where(eq(branch.branchId, testBranchId));
  }
});

describe("GET /products/:id", () => {
  test("returns 401 without a session", async () => {
    const response = await app.handle(
      new Request("http://localhost/products/1"),
    );
    expect(response.status).toBe(401);
  });

  test("returns 403 for a userType not allowed to read (customer)", async () => {
    const response = await app.handle(
      new Request("http://localhost/products/1", {
        headers: authHeaders(customerCookie),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("returns the matching product for an allowed userType (cashier)", async () => {
    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        headers: authHeaders(cashierCookie),
      }),
    );
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data).toEqual(createdBody.data);
  });

  test("returns 404 with an AppError envelope for a non-existent id", async () => {
    const response = await app.handle(
      new Request("http://localhost/products/999999999", {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /products", () => {
  test("creates a product as hq", async () => {
    const name = `Created Product ${crypto.randomUUID()}`;
    const response = await createProduct(hqCookie, { name });
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.name).toBe(name);
    expect(body.data.isActive).toBe(true);
  });

  test("returns 403 for a non-hq userType (cashier)", async () => {
    const response = await createProduct(cashierCookie);
    expect(response.status).toBe(403);
  });

  test("returns 400 for a negative costPrice", async () => {
    const response = await createProduct(hqCookie, { costPrice: -1 });
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 400 for a whitespace-only name", async () => {
    const response = await createProduct(hqCookie, { name: "   " });
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 409 with an AppError envelope for a duplicate barcode", async () => {
    const barcode = crypto.randomUUID();
    const first = await createProduct(hqCookie, { barcode });
    expect(first.status).toBe(200);

    const second = await createProduct(hqCookie, { barcode });
    const body = (await second.json()) as ErrorBody;

    expect(second.status).toBe(409);
    expect(body.error.code).toBe("ALREADY_EXISTS");
  });

  // Regression test for the barcode race condition: assertBarcodeAvailable()
  // is a check-then-insert with a TOCTOU gap, so two concurrent creates for
  // the same barcode could both pass the pre-check and both succeed, giving
  // two products the same physical barcode (a POS scan-ambiguity / price
  // substitution risk). The DB-level unique constraint on product.barcode
  // (plus the 23505 -> ALREADY_EXISTS mapping in the service) is the actual
  // fix; this proves the race can no longer produce two 200s.
  test("only one of two concurrent creates with the same barcode succeeds", async () => {
    const barcode = crypto.randomUUID();

    const [first, second] = await Promise.all([
      createProduct(hqCookie, { barcode }),
      createProduct(hqCookie, { barcode }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await db
      .select({ pId: product.pId })
      .from(product)
      .where(eq(product.barcode, barcode));
    expect(rows.length).toBe(1);
  });
});

describe("PATCH /products/:id", () => {
  test("updates fields as hq", async () => {
    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;
    const newName = `Updated Product ${crypto.randomUUID()}`;

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "PATCH",
        headers: authHeaders(hqCookie),
        body: JSON.stringify({ name: newName, costPrice: 2000 }),
      }),
    );
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.name).toBe(newName);
    expect(body.data.costPrice).toBe(2000);
  });

  test("returns 403 for a non-hq userType (cashier)", async () => {
    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "PATCH",
        headers: authHeaders(cashierCookie),
        body: JSON.stringify({ name: "Should not apply" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("returns 404 for a non-existent id", async () => {
    const response = await app.handle(
      new Request("http://localhost/products/999999999", {
        method: "PATCH",
        headers: authHeaders(hqCookie),
        body: JSON.stringify({ name: "Does not matter" }),
      }),
    );

    expect(response.status).toBe(404);
  });

  test("returns 409 when changing the barcode to one already used by another product", async () => {
    const takenBarcode = crypto.randomUUID();
    await createProduct(hqCookie, { barcode: takenBarcode });

    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "PATCH",
        headers: authHeaders(hqCookie),
        body: JSON.stringify({ barcode: takenBarcode }),
      }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("ALREADY_EXISTS");
  });
});

describe("DELETE /products/:id", () => {
  test("deactivates a product as hq", async () => {
    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "DELETE",
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.isActive).toBe(false);
  });

  test("returns 400 when the product is already deactivated", async () => {
    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;

    await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "DELETE",
        headers: authHeaders(hqCookie),
      }),
    );

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "DELETE",
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 403 for a non-hq userType (cashier)", async () => {
    const created = await createProduct(hqCookie);
    const createdBody = (await created.json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products/${createdBody.data.pId}`, {
        method: "DELETE",
        headers: authHeaders(cashierCookie),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("returns 404 for a non-existent id", async () => {
    const response = await app.handle(
      new Request("http://localhost/products/999999999", {
        method: "DELETE",
        headers: authHeaders(hqCookie),
      }),
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /products", () => {
  test("returns products matching a search term", async () => {
    const uniqueToken = crypto.randomUUID();
    const created = await createProduct(hqCookie, {
      name: `Searchable ${uniqueToken}`,
    });
    const createdBody = (await created.json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products?search=${uniqueToken}`, {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as SuccessBody<{
      products: Product[];
      total: number;
      page: number;
      totalPages: number;
      limit: number;
      offset: number;
    }>;

    expect(response.status).toBe(200);
    expect(body.data.products.map((p) => p.pId)).toContain(
      createdBody.data.pId,
    );
    expect(body.data.total).toBeGreaterThanOrEqual(1);
  });

  test("filters by categoryId", async () => {
    const inFirst = (await (
      await createProduct(hqCookie, {
        categoryIds: [firstCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;
    const inSecond = (await (
      await createProduct(hqCookie, {
        categoryIds: [secondCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(
        `http://localhost/products?categoryId=${firstCategory.categoryId}&limit=100`,
        { headers: authHeaders(hqCookie) },
      ),
    );
    const body = (await response.json()) as SuccessBody<{
      products: Product[];
    }>;
    const pIds = body.data.products.map((p) => p.pId);

    expect(response.status).toBe(200);
    expect(pIds).toContain(inFirst.data.pId);
    expect(pIds).not.toContain(inSecond.data.pId);
    for (const found of body.data.products) {
      expect(found.categories.map((c) => c.categoryId)).toContain(
        firstCategory.categoryId,
      );
    }
  });
});

describe("product categories", () => {
  test("POST links the given categories and returns them sorted by name", async () => {
    const response = await createProduct(hqCookie, {
      // out of order and with a duplicate, on purpose
      categoryIds: [
        secondCategory.categoryId,
        firstCategory.categoryId,
        secondCategory.categoryId,
      ],
    });
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.categories).toEqual([firstCategory, secondCategory]);

    const links = await db
      .select()
      .from(productCategoryMap)
      .where(eq(productCategoryMap.pId, body.data.pId));
    expect(links.length).toBe(2);
  });

  test("POST without categoryIds returns an empty categories array", async () => {
    const response = await createProduct(hqCookie);
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.categories).toEqual([]);
  });

  test("POST with an unknown category id returns 400 and creates nothing", async () => {
    const [{ highest }] = await db
      .select({ highest: max(productCategory.categoryId) })
      .from(productCategory);
    const unknownId = (highest ?? 0) + 1000;
    const barcode = crypto.randomUUID();

    const response = await createProduct(hqCookie, {
      barcode,
      categoryIds: [firstCategory.categoryId, unknownId],
    });
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.context?.categoryIds).toEqual([unknownId]);

    // the product insert is rolled back along with the failed category links
    const rows = await db
      .select({ pId: product.pId })
      .from(product)
      .where(eq(product.barcode, barcode));
    expect(rows.length).toBe(0);
  });

  test("GET /products/:id includes the product's categories", async () => {
    const created = (await (
      await createProduct(hqCookie, {
        categoryIds: [firstCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;

    const response = await app.handle(
      new Request(`http://localhost/products/${created.data.pId}`, {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.categories).toEqual([firstCategory]);
  });

  test("PATCH with only categoryIds replaces the categories and nothing else", async () => {
    const created = (await (
      await createProduct(hqCookie, {
        categoryIds: [firstCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;

    const response = await patchProduct(created.data.pId, {
      categoryIds: [secondCategory.categoryId],
    });
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.categories).toEqual([secondCategory]);
    expect(body.data.name).toBe(created.data.name);
    expect(body.data.barcode).toBe(created.data.barcode);
  });

  test("PATCH with categoryIds [] removes every category", async () => {
    const created = (await (
      await createProduct(hqCookie, {
        categoryIds: [firstCategory.categoryId, secondCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;

    const response = await patchProduct(created.data.pId, { categoryIds: [] });
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.categories).toEqual([]);
  });

  test("PATCH without categoryIds leaves the categories alone", async () => {
    const created = (await (
      await createProduct(hqCookie, {
        categoryIds: [firstCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;

    const response = await patchProduct(created.data.pId, { costPrice: 1234 });
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.costPrice).toBe(1234);
    expect(body.data.categories).toEqual([firstCategory]);
  });

  test("PATCH with an unknown category id returns 400 and keeps the old ones", async () => {
    const created = (await (
      await createProduct(hqCookie, {
        categoryIds: [firstCategory.categoryId],
      })
    ).json()) as SuccessBody<Product>;
    const [{ highest }] = await db
      .select({ highest: max(productCategory.categoryId) })
      .from(productCategory);

    const response = await patchProduct(created.data.pId, {
      name: "Should not apply",
      categoryIds: [(highest ?? 0) + 1000],
    });
    expect(response.status).toBe(400);

    const after = await app.handle(
      new Request(`http://localhost/products/${created.data.pId}`, {
        headers: authHeaders(hqCookie),
      }),
    );
    const afterBody = (await after.json()) as SuccessBody<Product>;
    expect(afterBody.data.name).toBe(created.data.name);
    expect(afterBody.data.categories).toEqual([firstCategory]);
  });

  test("PATCH with an empty body is a no-op, not a 500", async () => {
    const created = (await (
      await createProduct(hqCookie)
    ).json()) as SuccessBody<Product>;

    const response = await patchProduct(created.data.pId, {});
    const body = (await response.json()) as SuccessBody<Product>;

    expect(response.status).toBe(200);
    expect(body.data.name).toBe(created.data.name);
  });
});
