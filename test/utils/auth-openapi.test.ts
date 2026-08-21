import { describe, expect, test } from "bun:test";
import { getAuthOpenAPIDocumentation } from "@/utils";

describe("getAuthOpenAPIDocumentation", () => {
  test("only exposes the allow-listed better-auth paths", async () => {
    const { paths } = await getAuthOpenAPIDocumentation();

    expect(Object.keys(paths ?? {}).sort()).toEqual(
      [
        "/change-password",
        "/get-session",
        "/request-password-reset",
        "/reset-password",
        "/sign-in/email",
        "/sign-out",
      ].sort(),
    );
  });

  test("does not expose paths outside the allow-list, e.g. admin/create-user", async () => {
    const { paths } = await getAuthOpenAPIDocumentation();

    expect(paths).not.toHaveProperty("/admin/create-user");
    expect(paths).not.toHaveProperty("/sign-up/email");
  });

  test("retags every HTTP method on an exposed path as Better Auth", async () => {
    const { paths } = await getAuthOpenAPIDocumentation();
    const signIn = paths?.["/sign-in/email"] as Record<
      string,
      { tags?: string[] } | undefined
    >;

    expect(signIn.post?.tags).toEqual(["Better Auth"]);
  });

  test("includes the auth schema's components.schemas", async () => {
    const { components } = await getAuthOpenAPIDocumentation();

    expect(components?.schemas).toBeDefined();
    expect(Object.keys(components?.schemas ?? {}).length).toBeGreaterThan(0);
  });
});
