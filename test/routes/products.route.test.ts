import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { branch, product, user } from "@/db/schema";
import type { Product } from "@/models/products.model";
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
let testBranchId: number;
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

beforeAll(async () => {
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
    await db.delete(product).where(inArray(product.pId, createdProductIds));
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
});
