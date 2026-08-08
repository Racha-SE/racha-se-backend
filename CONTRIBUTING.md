# Contributing

Read this before writing code here. It explains the architecture, the conventions that come from it, and the mistakes already made (and fixed) so they don't happen again.

## Architecture

Four layers, one direction of dependency only — never import "up" the list:

- **`src/models/`** — `t.Object` schemas + derived TS types (via `Static<...>`). No logic, no imports from services/routes.
- **`src/services/`** — business logic. Imports models + utils. Throws `AppError` on failure, never returns an error object or throws a bare `Error`.
- **`src/routes/`** — HTTP layer only. Validates input (via model schemas), calls a service, wraps the result with `successResponse`/`tSuccessResponse`. No business logic here — if a route handler is more than a few lines, that logic belongs in a service.
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
- Don't hand-write DB-derived schemas field-by-field once real Drizzle tables exist — use `createSelectSchema`/`createInsertSchema` from `drizzle-typebox`. There is currently no `spread()`/`spreads()` helper for pulling `.properties` out of those into a composed `t.Object` — add one in `src/utils/` **only once** there's an actual Drizzle table and a real duplication problem to solve. Don't add it speculatively.

## Path aliases

- `@/*` maps to `src/*` (configured in `tsconfig.json` `paths`, no `baseUrl` needed).
- Use `@/...` for any cross-directory import. Keep same-directory imports relative (`./foo`).
- `test/` is not under `src/`, but the alias still resolves there too (`paths` in `tsconfig.json` isn't scoped to `src/`) — use `@/...` freely in tests.

## Dev-only / mock code

- Anything that's a demo/reference, not real product code, is gated behind `process.env.NODE_ENV === "development"` in `src/index.ts` — see how `mockRoute` is mounted. It must never be reachable when `NODE_ENV` is unset or `"production"`.
- Prefix such routes with `/mock` so it's obvious from the URL alone that it's not real.

## Testing

- Tests live in the top-level `test/` directory, mirroring `src/`'s structure — not colocated with source files.
- Route tests don't import the whole app from `src/index.ts` (that would pull in the `NODE_ENV` gate and `.listen()`). Instead build a minimal instance: `new Elysia().use(errorHandler).use(theRouteUnderTest)`, then drive it with `app.handle(new Request(...))`. No real port is bound — the URL's host/port in `new Request("http://localhost/...")` is never actually used for routing, only the path is.
- Assert on both `response.status` and the parsed body — a route returning the right body with the wrong status code (or vice versa) is a real, easy-to-miss bug class.

## Docker / ports

- Ports are intentionally non-default (`6767` backend, `6969` Postgres, `6769` Adminer) specifically to avoid clashing with other projects running locally at the same time. Don't "fix" them back to `3000`/`5432`.
- All services sit on a fixed-name bridge network (`racha-se-network`, not project-prefixed) so a separate frontend repo can join it later via `networks: { racha-se-network: { external: true } }`. Don't let Compose auto-generate the network name.

## Git / commits

- Conventional Commits only (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `perf:`, `revert:`, `style:`) — enforced by commitlint at the `commit-msg` stage. Not optional, not just a suggestion.
- Don't push directly to `main`. A local pre-push hook blocks it (bypassable with `--no-verify` — it's a courtesy check, not real security; there is no server-side branch protection yet).
- Install all three pre-commit hook stages (`pre-commit`, `commit-msg`, `pre-push`) — see README. Missing one means some checks silently never run on your machine, and you won't find out until CI (or a teammate) catches it.

## Lint / types

- ESLint runs **type-aware** rules (`typescript-eslint`'s `recommendedTypeChecked`), not just syntax rules. This is the whole reason ESLint was chosen over Biome — Biome can't do type-aware checks (`no-floating-promises`, `no-misused-promises`, `no-unsafe-*`) because its linter never touches the TypeScript compiler. Don't silence these with `// eslint-disable` — fix the actual type, e.g. by annotating a variable instead of leaving it inferred as `any`.
- `tsc --noEmit` passing is not the same as ESLint passing. `tsc` does not catch floating promises, misused promises in callbacks like `.forEach(async ...)`, or `any` leaking through the codebase — that's specifically what the ESLint type-aware rules are for. Both checks matter; neither is redundant with the other.
- Prettier formats everything automatically via the pre-commit hook (`prettier --write`) — don't hand-format or fight it. If `bun run format` fails in CI, run `bun run format:fix` locally and commit the result.

## General

- No premature abstraction. Several things in this repo were deliberately _not_ built ahead of need — e.g. no `spread()` schema helper until there's a real Drizzle table, no `tAppErrors()` multi-code-schema merger until routes actually need it. If you're about to add a generic helper "for later," don't — wait until there are two real call sites.
