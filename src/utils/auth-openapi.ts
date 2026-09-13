import type { openapi } from "@elysiajs/openapi";
import { auth } from "./auth";

type OpenAPIDocumentation = NonNullable<
  NonNullable<Parameters<typeof openapi>[0]>["documentation"]
>;

type AuthOpenAPISchema = Awaited<
  ReturnType<typeof auth.api.generateOpenAPISchema>
>;
type AuthPath = AuthOpenAPISchema["paths"][string];

const EXPOSED_AUTH_PATHS = new Set([
  "/sign-in/email",
  "/get-session",
  "/sign-out",
  "/change-password",
  "/request-password-reset",
  "/reset-password",
]);

const HTTP_METHODS = ["get", "put", "post", "patch", "delete"] as const;

function retagPath(pathItem: AuthPath): AuthPath {
  const retagged = { ...pathItem };
  for (const method of HTTP_METHODS) {
    const operation = retagged[method];
    if (operation) {
      retagged[method] = { ...operation, tags: ["Better Auth"] };
    }
  }
  return retagged;
}

export async function getAuthOpenAPIDocumentation(): Promise<
  Pick<OpenAPIDocumentation, "paths" | "components">
> {
  const authSchema = await auth.api.generateOpenAPISchema();
  const filteredPaths = Object.fromEntries(
    Object.entries(authSchema.paths)
      .filter(([path]) => EXPOSED_AUTH_PATHS.has(path))
      // better-auth's generator returns paths relative to its own routes
      // (e.g. "/sign-in/email") and never applies the configured `basePath`,
      // so the docs must be prefixed to match where auth.handler is actually mounted.
      .map(([path, pathItem]) => [
        `${auth.options.basePath}${path}`,
        retagPath(pathItem),
      ]),
  );

  return {
    paths: filteredPaths as unknown as OpenAPIDocumentation["paths"],
    components: {
      schemas: authSchema.components.schemas as unknown as NonNullable<
        OpenAPIDocumentation["components"]
      >["schemas"],
    },
  };
}
