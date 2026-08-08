import { Elysia } from "elysia";
import { errorHandler } from "@/plugins/error-handler";
import { healthRoute } from "@/routes/health.route";
import { mockRoute } from "@/routes/mock.route";

const app = new Elysia({ prefix: "/v1" }).use(errorHandler).use(healthRoute);

// mock routes exist only to demonstrate the architecture — never expose them outside dev
if (process.env.NODE_ENV === "development") {
  app.use(mockRoute);
}

app.listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
