import { Elysia } from "elysia";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute, healthRoute, mockAuthRoute, mockRoute } from "@/routes";

const app = new Elysia().use(authRoute).group("/v1", (app) => {
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
