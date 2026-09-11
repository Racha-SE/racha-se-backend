import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { errorHandler } from "@/plugins/error-handler";
import {
  authRoute,
  branchesRoute,
  categoriesRoute,
  healthRoute,
  inventoryRoute,
  mockAuthRoute,
  mockRoute,
  notificationsRoute,
  ordersBranchRoute,
  ordersHqRoute,
  productsRoute,
  suppliersRoute,
  usersRoute,
} from "@/routes";
import { getAuthOpenAPIDocumentation, verifyMailerConnection } from "@/utils";

const authDocs = await getAuthOpenAPIDocumentation();
await verifyMailerConnection();

export const app = new Elysia()
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
          { name: "Users", description: "User account management" },
          { name: "Suppliers", description: "Supplier reference data" },
          {
            name: "Products",
            description: "Product catalog and category assignments",
          },
          { name: "Categories", description: "Product category management" },
          {
            name: "Orders HQ",
            description: "Supplier orders into HQ stock",
          },
          {
            name: "Orders Branch",
            description: "Stock transfer requests from a branch to HQ",
          },
          {
            name: "Inventory",
            description: "Live, searchable stock-on-hand queries",
          },
          {
            name: "Notifications",
            description:
              "Persisted expire and min_stock alerts (HQ and branch scoped)",
          },
          { name: "Branches", description: "Branch master data management" },
          {
            name: "Mock",
            description:
              "Dev-only reference implementation (model/service/route pattern, and the auth macro pattern)",
          },
        ],
        paths: authDocs.paths,
        components: authDocs.components,
      },
    }),
  )
  .use(authRoute)
  .group("/api/v1", (app) => {
    app
      .use(errorHandler)
      .use(healthRoute)
      .use(usersRoute)
      .use(suppliersRoute)
      .use(productsRoute)
      .use(categoriesRoute)
      .use(ordersHqRoute)
      .use(ordersBranchRoute)
      .use(inventoryRoute)
      .use(notificationsRoute)
      .use(branchesRoute);

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
