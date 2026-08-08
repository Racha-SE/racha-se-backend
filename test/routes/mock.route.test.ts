import { afterAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { mockUsersTable } from "@/db/schema";
import type { User } from "@/models/user.model";
import { errorHandler } from "@/plugins/error-handler";
import { mockRoute } from "@/routes";
import type { ErrorResponse, SuccessResponse } from "@/utils";

// same composition as the real app (src/index.ts), minus the dev-only gate,
// so route tests exercise the same AppError -> envelope conversion
const app = new Elysia().use(errorHandler).use(mockRoute);

// mock_users is a real table shared with seed data (seeds/mock_users.sql) —
// track exactly which rows this suite creates and delete only those, so
// seeded/unrelated rows survive a test run instead of getting wiped too.
const createdIds: string[] = [];

async function postUser(name: unknown) {
  const response = await app.handle(
    new Request("http://localhost/mock/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );

  if (response.status === 200) {
    const body = (await response.clone().json()) as SuccessResponse<User>;
    createdIds.push(body.data.id);
  }

  return response;
}

afterAll(async () => {
  if (createdIds.length > 0) {
    await db
      .delete(mockUsersTable)
      .where(inArray(mockUsersTable.id, createdIds));
  }
});

describe("GET /mock/users", () => {
  test("returns created users wrapped in a success envelope", async () => {
    const createResponse = await postUser(
      `List Test User ${crypto.randomUUID()}`,
    );
    const created = (await createResponse.json()) as SuccessResponse<User>;

    const response = await app.handle(
      new Request("http://localhost/mock/users"),
    );
    const body = (await response.json()) as SuccessResponse<{ users: User[] }>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.users).toContainEqual(created.data);
  });
});

describe("GET /mock/users/:id", () => {
  test("returns the matching user", async () => {
    const createResponse = await postUser(
      `Get Test User ${crypto.randomUUID()}`,
    );
    const created = (await createResponse.json()) as SuccessResponse<User>;

    const response = await app.handle(
      new Request(`http://localhost/mock/users/${created.data.id}`),
    );
    const body = (await response.json()) as SuccessResponse<User>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: created.data });
  });

  test("returns 404 with an AppError envelope when a well-formed id does not exist", async () => {
    const response = await app.handle(
      new Request(`http://localhost/mock/users/${crypto.randomUUID()}`),
    );
    const body = (await response.json()) as ErrorResponse<"NOT_FOUND">;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: "NOT_FOUND", context: undefined },
    });
  });

  test("returns 400 with a normalized envelope when the id is not a valid uuid", async () => {
    const response = await app.handle(
      new Request("http://localhost/mock/users/not-a-uuid"),
    );
    const body = (await response.json()) as ErrorResponse<"VALIDATION">;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION");
  });
});

describe("POST /mock/users", () => {
  test("creates a new user", async () => {
    const name = `Route Test User ${crypto.randomUUID()}`;
    const response = await postUser(name);
    const body = (await response.json()) as SuccessResponse<User>;

    expect(response.status).toBe(200);
    expect(body.data.name).toBe(name);
  });

  test("returns 409 with an AppError envelope for a duplicate name", async () => {
    const name = `Duplicate Route User ${crypto.randomUUID()}`;
    await postUser(name);
    const response = await postUser(name);
    const body = (await response.json()) as ErrorResponse<"ALREADY_EXISTS">;

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: { code: "ALREADY_EXISTS", context: { name } },
    });
  });

  test("returns 400 with a normalized envelope for a body that fails schema validation", async () => {
    const response = await postUser(undefined);
    const body = (await response.json()) as ErrorResponse<"VALIDATION">;

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION");
  });
});
