import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { User } from "@/models/user.model";
import { errorHandler } from "@/plugins/error-handler";
import { mockRoute } from "@/routes/mock.route";
import type { ErrorResponse, SuccessResponse } from "@/utils";

// same composition as the real app (src/index.ts), minus the dev-only gate,
// so route tests exercise the same AppError -> envelope conversion
const app = new Elysia().use(errorHandler).use(mockRoute);

describe("GET /mock/users", () => {
  test("returns the seeded users wrapped in a success envelope", async () => {
    const response = await app.handle(
      new Request("http://localhost/mock/users"),
    );
    const body = (await response.json()) as SuccessResponse<{ users: User[] }>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.users).toContainEqual({ id: "1", name: "Narumed" });
  });
});

describe("GET /mock/users/:id", () => {
  test("returns the matching user", async () => {
    const response = await app.handle(
      new Request("http://localhost/mock/users/1"),
    );
    const body = (await response.json()) as SuccessResponse<User>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { id: "1", name: "Narumed" } });
  });

  test("returns 404 with an AppError envelope when the user does not exist", async () => {
    const response = await app.handle(
      new Request("http://localhost/mock/users/999"),
    );
    const body = (await response.json()) as ErrorResponse<"NOT_FOUND">;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: "NOT_FOUND", context: undefined },
    });
  });
});

describe("POST /mock/users", () => {
  const postUser = (name: unknown) =>
    app.handle(
      new Request("http://localhost/mock/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );

  test("creates a new user", async () => {
    const response = await postUser("Route Test User");
    const body = (await response.json()) as SuccessResponse<User>;

    expect(response.status).toBe(200);
    expect(body.data.name).toBe("Route Test User");
  });

  test("returns 409 with an AppError envelope for a duplicate name", async () => {
    await postUser("Duplicate Route User");
    const response = await postUser("Duplicate Route User");
    const body = (await response.json()) as ErrorResponse<"ALREADY_EXISTS">;

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error: {
        code: "ALREADY_EXISTS",
        context: { name: "Duplicate Route User" },
      },
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
