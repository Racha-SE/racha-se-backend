import { afterAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { user } from "@/db/schema";
import { authRoute } from "@/routes/auth.route";
import { mockAuthRoute } from "@/routes/mock-auth.route";
import { auth } from "@/utils";

// authRoute is needed too — sign-in in the test helper below goes through
// the real /api/auth/sign-in/email handler, not just the mocked routes.
const app = new Elysia().use(authRoute).use(mockAuthRoute);

// account/session rows cascade-delete via their user_id FK (see
// src/db/schema/auth.ts), so tracking + deleting the user row is enough.
const createdIds: string[] = [];

async function createSignedInUser(userType: "hq" | "customer") {
  const email = `mock-auth-route-test-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  const result = await auth.api.createUser({
    body: {
      email,
      password,
      name: "Mock Auth Route Test",
      data: {
        userType,
        firstname: "Mock",
        lastname: "Test",
        username: `mockauthroutetest${crypto.randomUUID()}`,
      },
    },
  });
  createdIds.push(result.user.id);

  const signInResponse = await app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = signInResponse.headers.get("set-cookie")?.split(";")[0];
  return { email, cookie };
}

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(user).where(inArray(user.id, createdIds));
  }
});

describe("GET /mock/auth/me", () => {
  test("returns the signed-in user for any userType", async () => {
    const { email, cookie } = await createSignedInUser("customer");

    const response = await app.handle(
      new Request("http://localhost/mock/auth/me", {
        headers: cookie ? { Cookie: cookie } : {},
      }),
    );
    const body = (await response.json()) as {
      success: boolean;
      data: { email: string; userType: string };
    };

    expect(response.status).toBe(200);
    expect(body.data.email).toBe(email);
    expect(body.data.userType).toBe("customer");
  });

  test("returns 401 without a session", async () => {
    const response = await app.handle(
      new Request("http://localhost/mock/auth/me"),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /mock/auth/hq-only", () => {
  test("returns 200 for an hq user", async () => {
    const { cookie } = await createSignedInUser("hq");

    const response = await app.handle(
      new Request("http://localhost/mock/auth/hq-only", {
        headers: cookie ? { Cookie: cookie } : {},
      }),
    );

    expect(response.status).toBe(200);
  });

  test("returns 403 for a non-hq user", async () => {
    const { cookie } = await createSignedInUser("customer");

    const response = await app.handle(
      new Request("http://localhost/mock/auth/hq-only", {
        headers: cookie ? { Cookie: cookie } : {},
      }),
    );

    expect(response.status).toBe(403);
  });

  test("returns 401 without a session", async () => {
    const response = await app.handle(
      new Request("http://localhost/mock/auth/hq-only"),
    );

    expect(response.status).toBe(401);
  });
});
