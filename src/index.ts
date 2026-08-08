import { Elysia } from "elysia";
import { errorHandler } from "@/plugins/error-handler";
import { authRoute } from "@/routes/auth.route";
import { healthRoute } from "@/routes/health.route";
import { mockAuthRoute } from "@/routes/mock-auth.route";
import { mockRoute } from "@/routes/mock.route";

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
