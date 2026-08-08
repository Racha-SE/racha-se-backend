import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { user } from "@/db/schema";
import { authRoute } from "@/routes/auth.route";
import { auth } from "@/utils";

const app = new Elysia().use(authRoute);

// CSRF origin-check only kicks in for requests that carry a session cookie
// (see the write-up below on /admin/create-user) — sign-in/sign-up requests
// don't need it, but sign-out/change-password/admin/* do.
const ORIGIN = process.env.BETTER_AUTH_URL!;

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  banned: boolean | null;
  userType: string;
  firstname: string;
  lastname: string;
  username: string;
  isActive: boolean;
  birthdate: string | null;
  branchId: number | null;
}

interface SignInBody {
  token: string;
  user: AuthUser;
}

interface AuthErrorBody {
  message: string;
  code: string;
}

interface SessionBody {
  session: { id: string; userId: string; token: string };
  user: AuthUser;
}

interface CreateUserBody {
  user: AuthUser;
}

interface SignOutBody {
  success: boolean;
}

const createdIds: string[] = [];

function uniqueEmail() {
  return `auth-route-test-${crypto.randomUUID()}@example.com`;
}

function uniqueUsername() {
  return `authroutetest${crypto.randomUUID()}`;
}

async function createTestUser(
  overrides: { role?: "user" | "admin"; userType?: string } = {},
) {
  const email = uniqueEmail();
  const password = "password123";
  const result = await auth.api.createUser({
    body: {
      email,
      password,
      name: "Auth Route Test",
      role: overrides.role,
      data: {
        userType: overrides.userType ?? "customer",
        firstname: "Auth",
        lastname: "Test",
        username: uniqueUsername(),
      },
    },
  });

  createdIds.push(result.user.id);
  return { email, password, user: result.user as unknown as AuthUser };
}

async function signIn(email: string, password: string) {
  const response = await app.handle(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { response, cookie };
}

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(user).where(inArray(user.id, createdIds));
  }
});

describe("POST /api/auth/sign-up/email", () => {
  test("returns 400 — public self sign-up is disabled", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: uniqueEmail(),
          password: "password123",
          name: "Should Not Work",
          userType: "hq",
          firstname: "Should",
          lastname: "Not Work",
          username: uniqueUsername(),
        }),
      }),
    );
    const body = (await response.json()) as AuthErrorBody;

    expect(response.status).toBe(400);
    expect(body.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
  });
});

describe("POST /api/auth/admin/create-user", () => {
  test("returns 401 for an unauthenticated request", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/admin/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          email: uniqueEmail(),
          password: "password123",
          name: "No Session",
          data: {
            userType: "customer",
            firstname: "No",
            lastname: "Session",
            username: uniqueUsername(),
          },
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  test("returns 403 when the caller is not an admin", async () => {
    const nonAdmin = await createTestUser({ userType: "customer" });
    const { cookie } = await signIn(nonAdmin.email, nonAdmin.password);

    const response = await app.handle(
      new Request("http://localhost/api/auth/admin/create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: cookie ?? "",
        },
        body: JSON.stringify({
          email: uniqueEmail(),
          password: "password123",
          name: "Via Non Admin",
          data: {
            userType: "customer",
            firstname: "Via",
            lastname: "NonAdmin",
            username: uniqueUsername(),
          },
        }),
      }),
    );
    const body = (await response.json()) as AuthErrorBody;

    expect(response.status).toBe(403);
    expect(body.code).toBe("YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS");
  });

  test("returns 500 when creating a branch user without a branchId", async () => {
    const admin = await createTestUser({ role: "admin", userType: "hq" });
    const { cookie } = await signIn(admin.email, admin.password);

    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    const response = await app.handle(
      new Request("http://localhost/api/auth/admin/create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: cookie ?? "",
        },
        body: JSON.stringify({
          email: uniqueEmail(),
          password: "password123",
          name: "Created By Admin",
          data: {
            userType: "branch",
            firstname: "Created",
            lastname: "ByAdmin",
            username: uniqueUsername(),
          },
        }),
      }),
    );

    consoleError.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });

  test("creates a customer user when the caller has the admin role", async () => {
    const admin = await createTestUser({ role: "admin", userType: "hq" });
    const { cookie } = await signIn(admin.email, admin.password);

    const response = await app.handle(
      new Request("http://localhost/api/auth/admin/create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: cookie ?? "",
        },
        body: JSON.stringify({
          email: uniqueEmail(),
          password: "password123",
          name: "Created By Admin",
          data: {
            userType: "customer",
            firstname: "Created",
            lastname: "ByAdmin",
            username: uniqueUsername(),
          },
        }),
      }),
    );
    const body = (await response.json()) as CreateUserBody;

    if (response.status === 200) {
      createdIds.push(body.user.id);
    }

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({
      userType: "customer",
      firstname: "Created",
      lastname: "ByAdmin",
    });
  });
});

describe("POST /api/auth/sign-in/email", () => {
  test("returns a session token for correct credentials", async () => {
    const { email, password } = await createTestUser();

    const { response } = await signIn(email, password);
    const body = (await response.json()) as SignInBody;

    expect(response.status).toBe(200);
    expect(body.token).toBeString();
    expect(body.user.email).toBe(email);
  });

  test("returns 401 for the wrong password", async () => {
    const { email } = await createTestUser();

    const { response } = await signIn(email, "wrong-password");
    const body = (await response.json()) as AuthErrorBody;

    expect(response.status).toBe(401);
    expect(body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });
});

describe("GET /api/auth/get-session", () => {
  test("returns the session and user for a signed-in request", async () => {
    const { email, password } = await createTestUser();
    const { cookie } = await signIn(email, password);

    const response = await app.handle(
      new Request("http://localhost/api/auth/get-session", {
        headers: cookie ? { Cookie: cookie } : {},
      }),
    );
    const body = (await response.json()) as SessionBody;

    expect(response.status).toBe(200);
    expect(body.user.email).toBe(email);
    expect(body.session.userId).toBe(body.user.id);
  });

  test("returns an empty body when there is no session", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/get-session"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe("null");
  });
});

describe("POST /api/auth/sign-out", () => {
  test("invalidates the session", async () => {
    const { email, password } = await createTestUser();
    const { cookie } = await signIn(email, password);

    const signOutResponse = await app.handle(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie ?? "" },
      }),
    );
    const signOutBody = (await signOutResponse.json()) as SignOutBody;

    expect(signOutResponse.status).toBe(200);
    expect(signOutBody.success).toBe(true);

    const sessionResponse = await app.handle(
      new Request("http://localhost/api/auth/get-session", {
        headers: cookie ? { Cookie: cookie } : {},
      }),
    );
    const sessionBody = await sessionResponse.text();

    expect(sessionResponse.status).toBe(200);
    expect(sessionBody).toBe("null");
  });
});

describe("POST /api/auth/change-password", () => {
  test("changes the password and invalidates the old one", async () => {
    const { email, password } = await createTestUser();
    const { cookie } = await signIn(email, password);
    const newPassword = "newpassword456";

    const changeResponse = await app.handle(
      new Request("http://localhost/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: cookie ?? "",
        },
        body: JSON.stringify({
          currentPassword: password,
          newPassword,
        }),
      }),
    );

    expect(changeResponse.status).toBe(200);

    const oldPasswordResponse = await signIn(email, password);
    expect(oldPasswordResponse.response.status).toBe(401);

    const newPasswordResponse = await signIn(email, newPassword);
    expect(newPasswordResponse.response.status).toBe(200);
  });

  test("returns 400 for an incorrect current password", async () => {
    const { email, password } = await createTestUser();
    const { cookie } = await signIn(email, password);

    const response = await app.handle(
      new Request("http://localhost/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: cookie ?? "",
        },
        body: JSON.stringify({
          currentPassword: "wrong-current-password",
          newPassword: "irrelevant123",
        }),
      }),
    );
    const body = (await response.json()) as AuthErrorBody;

    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PASSWORD");
  });
});
