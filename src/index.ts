import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, healthRoute, mockAuthRoute, mockRoute } from "@/routes";
import { getAuthOpenAPIDocumentation } from "@/utils";

const authDocs = await getAuthOpenAPIDocumentation();

const app = new Elysia()
  .use(
    cors({
      origin: process.env.CORS_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  )
  .use(
    openapi({
      provider: "scalar", // scalar | swagger-ui
      documentation: {
        info: {
          title: "Racha SE - Backend",
          version: "1.0.0",
        },
        tags: [
          { name: "Health", description: "Liveness checks" },
          {
            name: "Better Auth",
            description: "Better-auth's own routes, mounted at /api/v1/auth/*",
          },
          {
            name: "Mock",
            description:
              "Dev-only reference implementation (model/service/route pattern)",
          },
          {
            name: "Mock Auth",
            description:
              "Dev-only reference implementation (auth macro pattern)",
          },
        ],
        paths: authDocs.paths,
        components: authDocs.components,
      },
    }),
  )
  .use(authRoute)
  .group("/api/v1", (app) => {
    app.use(errorHandler).use(healthRoute);

    // mock routes exist only to demonstrate the architecture — never expose them outside dev
    if (process.env.NODE_ENV === "development") {
      app.use(mockRoute).use(mockAuthRoute);
    }

    return app;
  });

app.listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
