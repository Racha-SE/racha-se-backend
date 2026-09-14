import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, max } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "@/db/client";
import { branch, supplier, user } from "@/db/schema";
import type { Supplier } from "@/models/suppliers.model";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, suppliersRoute } from "@/routes";
import { auth, type UserType } from "@/utils";

// Same composition as the real app (src/index.ts), minus the dev-only gate
// and the /api/v1 grouping — authRoute for real sign-in, errorHandler +
// suppliersRoute (which pulls in authPlugin itself) for the API under test.
const app = new Elysia().use(authRoute).use(errorHandler).use(suppliersRoute);

interface SuccessBody<T> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; context?: Record<string, unknown> };
}

const createdUserIds: string[] = [];
const createdSupplierIds: number[] = [];
let testBranchId: number;
let hqCookie: string;
let branchCookie: string;

async function createSignedInUser(userType: UserType, branchId?: number) {
  const email = `suppliers-route-test-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  const result = await auth.api.createUser({
    body: {
      email,
      password,
      name: "Suppliers Route Test",
      data: {
        userType,
        firstname: "Suppliers",
        lastname: "Test",
        username: `suppliersroutetest${crypto.randomUUID()}`,
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

async function createSupplier(overrides: Record<string, unknown> = {}) {
  const [created] = await db
    .insert(supplier)
    .values({
      name: `Test Supplier ${crypto.randomUUID()}`,
      contact: "supplier@example.com",
      ...overrides,
    })
    .returning();
  createdSupplierIds.push(created.supplierId);

  return created;
}

beforeAll(async () => {
  const [createdBranch] = await db
    .insert(branch)
    .values({
      name: `Suppliers Test Branch ${crypto.randomUUID()}`,
      address: "123 Test St",
      phoneNumber: "0000000000",
    })
    .returning();
  testBranchId = createdBranch.branchId;

  hqCookie = await createSignedInUser("hq");
  branchCookie = await createSignedInUser("branch", testBranchId);
});

afterAll(async () => {
  if (createdSupplierIds.length > 0) {
    await db
      .delete(supplier)
      .where(inArray(supplier.supplierId, createdSupplierIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(user).where(inArray(user.id, createdUserIds));
  }
  if (testBranchId !== undefined) {
    await db.delete(branch).where(eq(branch.branchId, testBranchId));
  }
});

describe("GET /suppliers", () => {
  test("returns 401 without a session", async () => {
    const response = await app.handle(
      new Request("http://localhost/suppliers"),
    );
    expect(response.status).toBe(401);
  });

  test("returns 403 for a userType not allowed to read (branch)", async () => {
    const response = await app.handle(
      new Request("http://localhost/suppliers", {
        headers: authHeaders(branchCookie),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("returns suppliers including a freshly created one (hq)", async () => {
    const created = await createSupplier();

    const response = await app.handle(
      new Request("http://localhost/suppliers", {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as SuccessBody<{
      result: Supplier[];
    }>;

    expect(response.status).toBe(200);
    expect(body.data.result.map((s) => s.supplierId)).toContain(
      created.supplierId,
    );
  });
});

describe("GET /suppliers/:id", () => {
  test("returns 401 without a session", async () => {
    const response = await app.handle(
      new Request("http://localhost/suppliers/1"),
    );
    expect(response.status).toBe(401);
  });

  test("returns 403 for a userType not allowed to read (branch)", async () => {
    const created = await createSupplier();

    const response = await app.handle(
      new Request(`http://localhost/suppliers/${created.supplierId}`, {
        headers: authHeaders(branchCookie),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("returns the matching supplier for hq", async () => {
    const created = await createSupplier();

    const response = await app.handle(
      new Request(`http://localhost/suppliers/${created.supplierId}`, {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as SuccessBody<{
      result: Supplier;
    }>;

    expect(response.status).toBe(200);
    expect(body.data.result).toMatchObject({
      supplierId: created.supplierId,
      name: created.name,
      contact: created.contact,
    });
    expect(new Date(body.data.result.createdAt)).toEqual(created.createdAt);
    expect(new Date(body.data.result.updatedAt)).toEqual(created.updatedAt);
  });

  test("returns 404 with an AppError envelope for a non-existent id", async () => {
    const [{ highest }] = await db
      .select({ highest: max(supplier.supplierId) })
      .from(supplier);
    const missingId = (highest ?? 0) + 1000;

    const response = await app.handle(
      new Request(`http://localhost/suppliers/${missingId}`, {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 400 with a VALIDATION envelope for a non-numeric id", async () => {
    const response = await app.handle(
      new Request("http://localhost/suppliers/not-a-number", {
        headers: authHeaders(hqCookie),
      }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });
});
