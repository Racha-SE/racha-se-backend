# Contributing

Read this before writing code here. It explains the architecture, the conventions that come from it, and the mistakes already made (and fixed) so they don't happen again.

## Architecture

Four layers, one direction of dependency only — never import "up" the list:

- **`src/models/`** — `t.Object` schemas + derived TS types (via `Static<...>`). No logic, no imports from services/routes.
- **`src/services/`** — business logic. Imports models + utils. Throws `AppError` on failure, never returns an error object or throws a bare `Error`.
- **`src/routes/`** — HTTP layer only. Validates input (via model schemas), calls a service, wraps the result with `successResponse`/`tSuccessResponse`. No business logic here — if a route handler is more than a few lines, that logic belongs in a service. `index.ts` re-exports every route — same barrel pattern as `src/utils/`. Import via `@/routes` from outside the directory.
- **`src/utils/`** — cross-cutting helpers with no knowledge of any specific domain (`error.ts`, `response.ts`). Import via the barrel `@/utils`, not the individual file, from outside `src/utils/`. Inside `src/utils/`, same-directory imports stay relative (`./error`), not through the barrel — avoids a self-referential import.
- **`src/plugins/`** — Elysia plugins meant to be `.use()`'d by the app or by tests (e.g. `error-handler.ts`). If a plugin only adds a lifecycle hook (like `onError`) and no routes, it must call `.as("global")` — Elysia scopes plugin hooks locally by default, so without it the hook silently stops catching errors thrown by routes mounted from a different plugin. This bit us once already.

## Errors

- Never `throw new Error(...)` or hand-build an error JSON response. Always `throw new AppError("SOME_CODE", context?)`.
- Add new codes to `AppErrorCode` in `src/utils/error.ts`, sorted **alphabetically by key**, not by HTTP status.
- The global `errorHandler` plugin (`src/plugins/error-handler.ts`) is the only place that catches `AppError` and turns it into the `{ success: false, error: { code, context } }` envelope + correct HTTP status. Don't catch-and-format `AppError` anywhere else.
- Elysia's own schema-validation failures (`code === "VALIDATION"` in `onError`) are also normalized into our envelope, in `errorHandler` — same shape as `AppError`, status `400`, context is `{ on, property, summary }` built from Elysia's `mapValueError`. Don't reintroduce a separate raw-Elysia error path for these.

## Response shapes

- Success: `successResponse(data)` in handlers, `tSuccessResponse(schema)` in the route's `response` option.
- Error: never call `errorResponse` directly from a route — throw `AppError` instead and let the global handler build it. Use `tErrorResponse("CODE")` in the route's `response` option so the OpenAPI-ish schema documents it.
- Need to type a parsed response body in a test (e.g. `await response.json()`)? Use `SuccessResponse<T>` / `ErrorResponse<T>` from `@/utils` — they're derived via `ReturnType<typeof successResponse<T>>`, not hand-duplicated shapes. Don't type it `any` or `unknown` and move on; ESLint's type-aware rules (`no-unsafe-assignment`, `no-unsafe-member-access`) will fail the build if you do, because `Response.json()` is `Promise<any>` by spec.

## Models

- A model file exports a plain object grouping its schemas (`UserModel = { entity, params, createBody }`), not an Elysia `.model()` plugin. Chosen deliberately over the Elysia plugin pattern to keep schemas usable as plain values (`t.Array(UserModel.entity)`, `Static<typeof UserModel.entity>`) without needing string-ref lookups.
- Don't hand-write DB-derived schemas field-by-field — use `createSelectSchema`/`createInsertSchema` from `drizzle-typebox` (see `src/models/user.model.ts`) and narrow with `t.Pick`/`t.Omit` for `params`/`createBody`. No `spread()`/`spreads()` helper exists for merging fields from _multiple_ schemas into one `t.Object` — `t.Pick`/`t.Omit` on a single schema has covered every case so far. Only add `spread()` in `src/utils/` if a model genuinely needs to mix fields from more than one table schema.

## Path aliases

- `@/*` maps to `src/*` (configured in `tsconfig.json` `paths`, no `baseUrl` needed).
- Use `@/...` for any cross-directory import. Keep same-directory imports relative (`./foo`).
- `test/` is not under `src/`, but the alias still resolves there too (`paths` in `tsconfig.json` isn't scoped to `src/`) — use `@/...` freely in tests.

## Dev-only / mock code

- Anything that's a demo/reference, not real product code, is gated behind `process.env.NODE_ENV === "development"` in `src/index.ts` — see how `mockRoute` is mounted. It must never be reachable when `NODE_ENV` is unset or `"production"`.
- Prefix such routes with `/mock` so it's obvious from the URL alone that it's not real.
- `mock.route.ts`/`user.service.ts` query a real table (`mockUsersTable` in `src/db/schema/mock_users.ts`) through Drizzle — it's a working example of the full DB-backed pattern (model derived via `drizzle-typebox`, async service, real queries), kept deliberately separate from the real business tables (`user`, `branch`, `product`, `order`, ...) so demo traffic never touches them. When you build a real (non-mock) route against the real schema, copy this pattern, not the old in-memory-array one.
- `mock-auth.route.ts` is the same idea for `src/plugins/auth.plugin.ts`'s `auth` macro — `GET /mock/auth/me` (any signed-in user) and `GET /mock/auth/hq-only` (userType-gated). Copy this pattern for real protected routes.

## Authentication

- `src/utils/auth.ts` builds the single `auth` instance (config + drizzle adapter), with `basePath: "/api/v1/auth"` set explicitly (better-auth's own default is `/api/auth` — overridden here so it lands under the same `/api/v1` prefix as everything else). `src/routes/auth.route.ts` mounts it: `.mount(auth.handler)` with **no path argument** — better-auth's own `basePath` already resolves to `/api/v1/auth`, passing a path adds an _extra_ prefix on top instead of matching it (verified: `.mount('/auth', handler)` serves at `/auth/api/v1/auth`, not `/auth`).
- `authRoute` is `.use()`'d on a plain top-level `Elysia()` instance in `src/index.ts`, not inside the `{ prefix: "/api/v1" }` group — chaining `.mount()` under a prefixed instance shadows the raw handler (404s on both the prefixed and unprefixed path). Verified empirically; not documented behavior. This is why better-auth's own `basePath` has to carry the `/api/v1` prefix instead of relying on Elysia's `.group()` to add it.
- Two separate role concepts, don't conflate them: `role` (`admin`/`user`, from the better-auth `admin` plugin) only gates `/admin/create-user` and friends. `userType` (`hq`/`branch`/`cashier`/`customer`) is the actual business role, used everywhere else — including `auth.plugin.ts`'s macro (`{ auth: ["hq"] }`).
- Public sign-up is disabled (`emailAndPassword.disableSignUp` in `auth.ts`) — this is a warehouse system, accounts are provisioned by an admin via `/admin/create-user`, not self-service. The first admin (who provisions everyone else) is bootstrapped via `scripts/create-admin.ts`, which calls `auth.api.createUser()` server-side with no headers — better-auth's own trusted-server-context bypass for exactly this bootstrap problem (confirmed by reading `better-call`'s session check).
- Tests for auth-backed routes can't use public sign-up either — fixtures go through the same `auth.api.createUser()` bootstrap path (see `test/routes/auth.route.test.ts`'s `createTestUser` helper).
- `auth.plugin.ts`'s macro does **not** need `.as("global")` the way `error-handler.ts`'s `onError` hook does — verified it propagates fine across separately composed Elysia instances without it. Don't assume every plugin needs the same fix; check which kind of plugin it is.
- better-auth's own logger is disabled when `NODE_ENV === "test"` (`src/utils/auth.ts`) — `bun test` sets this automatically, no need to set it yourself. It silences most but not all noise: one path (`better-call`'s fallback 500 for an uncaught DB error) is a hardcoded `console.error`, not routed through better-auth's configurable logger — spy it out per-test where it's deliberately triggered (see the `spyOn` usage in `auth.route.test.ts`).
- CORS (`@elysiajs/cors`, browser-facing) and better-auth's `trustedOrigins` (`auth.ts`, server-side) are two independent mechanisms that happen to both read `CORS_ORIGIN` — satisfying one doesn't satisfy the other. Don't assume adding one covers the other.
- `bunx @better-auth/cli generate` cannot run against this repo directly — it runs under Node/jiti, which can't resolve `drizzle-orm/bun-sql` (`src/db/client.ts`'s driver). If better-auth schema ever changes again (a new plugin, etc.), apply the change by hand: read the expected shape from `node_modules/better-auth`/`node_modules/@better-auth/core` source, same as how `session`/`account`/`verification` were originally built.

## Database

- `src/db/schema/` holds every table, one file per domain (`user.ts`, `branch.ts`, `supplier.ts`, `product.ts` — includes `productCategory`/`productCategoryMap`, `order.ts` — includes the 3 order-detail tables, `stock_adjustment.ts`, `mock_users.ts`). `helpers.ts` has the shared `createdAt`/`updatedAt` column builders (as _functions_ — Drizzle column builders attach to one table internally, so a shared static object would corrupt every table that reused it). All `relations(...)` live together in `relations.ts`, not colocated with their tables. `index.ts` re-exports everything — same barrel pattern as `src/utils/`. Import from `@/db/schema`, not a specific file inside it, unless you're another file within `src/db/schema/` itself.
- `src/db/client.ts` exports `db`, built with `drizzle-orm/bun-sql` (Bun's native `Bun.sql`, no extra driver dependency). Import `db` from there — don't construct a second client anywhere.
- `postgres` is a **devDependency**, not something the app itself uses — `drizzle-kit`'s own CLI (`generate`/`migrate`/`studio`) needs it internally regardless of which driver `src/db/client.ts` uses. Don't remove it thinking it's dead weight; `bun run db:migrate` breaks without it. This was caught by a `bun install --frozen-lockfile` inside a Docker build failing with "please install pg/postgres" — the package existed in a dev machine's `node_modules` from a stray non-frozen install but was never actually in `bun.lock`, so it silently worked on that machine and nowhere else. If a DB script mysteriously works locally but fails in CI/Docker, suspect exactly this.
- Changed the schema? `bun run db:generate` then `bun run db:migrate` (see README). Never hand-edit a migration file that's already been applied; generate a new one.
- Tests that write through `db` (e.g. `test/services/user.service.test.ts`, `test/routes/mock.route.test.ts`) hit the real dev Postgres, not a mock/in-memory stand-in — they use `crypto.randomUUID()` in test data to avoid colliding with leftover rows from a previous run, and clean up in `afterAll` by **tracking the exact ids they create** and deleting only those (`db.delete(table).where(inArray(table.id, createdIds))`). Don't `db.delete(table)` with no `where` — that deletes every row in the table, including seed data (`seeds/mock_users.sql`) and anything else that happens to be there. Follow the id-tracking pattern for new DB-backed tests.
- Constructs the Drizzle schema builder can't express (triggers, stored procedures) go in a **custom migration** — `bunx drizzle-kit generate --custom --name=<name>` makes an empty file in `src/db/migrations/`; write raw SQL into it. `src/db/migrations/0001_triggers.sql` is the example. `seeds/triggers.sql` is a **reference copy only** — it says so at the top of the file — editing it does nothing to the database; edit the migration (or generate a new one) instead.
- `seeds/` is at the repo root, not under `src/db/` — seed data (`mock_users.sql`) isn't schema, so it doesn't live alongside `src/db/schema/`/`src/db/migrations/`.

## Testing

- Tests live in the top-level `test/` directory, mirroring `src/`'s structure — not colocated with source files.
- Route tests don't import the whole app from `src/index.ts` (that would pull in the `NODE_ENV` gate and `.listen()`). Instead build a minimal instance: `new Elysia().use(errorHandler).use(theRouteUnderTest)`, then drive it with `app.handle(new Request(...))`. No real port is bound — the URL's host/port in `new Request("http://localhost/...")` is never actually used for routing, only the path is.
- Assert on both `response.status` and the parsed body — a route returning the right body with the wrong status code (or vice versa) is a real, easy-to-miss bug class.

## Docker / ports

- Ports are intentionally non-default (`6767` backend, `6969` Postgres, `6769` Adminer) specifically to avoid clashing with other projects running locally at the same time. Don't "fix" them back to `3000`/`5432`.
- All services sit on a fixed-name bridge network (`racha-se-network`, not project-prefixed) so a separate frontend repo can join it later via `networks: { racha-se-network: { external: true } }`. Don't let Compose auto-generate the network name.
- The `backend` image does **not** run migrations on container start — deliberately, to keep "run a migration" a separate, explicit, human-triggered step rather than something that happens implicitly (and potentially races across replicas) every time the container boots. Run `docker compose run --rm backend bun run db:migrate` before the backend needs a fresh table. Don't add `db:migrate` back into the `Dockerfile`'s `CMD` — it was tried and deliberately reverted (see git history).

## Git / commits

- Conventional Commits only (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `perf:`, `revert:`, `style:`) — enforced by commitlint at the `commit-msg` stage. Not optional, not just a suggestion.
- Don't push directly to `main`. A local pre-push hook blocks it (bypassable with `--no-verify` — it's a courtesy check, not real security; there is no server-side branch protection yet).
- Install all three pre-commit hook stages (`pre-commit`, `commit-msg`, `pre-push`) — see README. Missing one means some checks silently never run on your machine, and you won't find out until CI (or a teammate) catches it.

## Lint / types

- ESLint runs **type-aware** rules (`typescript-eslint`'s `recommendedTypeChecked`), not just syntax rules. This is the whole reason ESLint was chosen over Biome — Biome can't do type-aware checks (`no-floating-promises`, `no-misused-promises`, `no-unsafe-*`) because its linter never touches the TypeScript compiler. Don't silence these with `// eslint-disable` — fix the actual type, e.g. by annotating a variable instead of leaving it inferred as `any`.
- `tsc --noEmit` passing is not the same as ESLint passing. `tsc` does not catch floating promises, misused promises in callbacks like `.forEach(async ...)`, or `any` leaking through the codebase — that's specifically what the ESLint type-aware rules are for. Both checks matter; neither is redundant with the other.
- Prettier formats everything automatically via the pre-commit hook (`prettier --write`) — don't hand-format or fight it. If `bun run format` fails in CI, run `bun run format:fix` locally and commit the result.

## General

- No premature abstraction. Several things in this repo were deliberately _not_ built ahead of need — e.g. no `spread()` multi-schema-merge helper (`t.Pick`/`t.Omit` on a single schema has been enough so far, even with real Drizzle tables), no `tAppErrors()` multi-code-schema merger until routes actually need it. If you're about to add a generic helper "for later," don't — wait until there are two real call sites.
