# racha-se-backend

Backend API built with [Elysia](https://elysiajs.com) on the [Bun](https://bun.sh) runtime.

## Prerequisites

- [Bun](https://bun.sh) (JS runtime + package manager)
- [Docker](https://www.docker.com/) + Docker Compose (for Postgres/Adminer)
- [pre-commit](https://pre-commit.com) (`brew install pre-commit` / `pip install pre-commit`)

## Setup

```bash
# 1. install dependencies
bun install

# 2. copy env vars
cp .env.example .env

# 3. install git hooks (all three stages — see "Pre-commit" below)
pre-commit install
pre-commit install --hook-type commit-msg
pre-commit install --hook-type pre-push

# 4. start Postgres + Adminer + Mailpit (SMTP catcher, see "Docker" below)
docker compose up -d db adminer mailpit

# 5. run database migrations
bun run db:migrate

# 6. bootstrap the first admin account (see "Authentication" below) —
#    run once per environment, pass real values instead of these placeholders
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD=change-me-immediately \
ADMIN_FIRSTNAME=Admin \
ADMIN_LASTNAME=User \
ADMIN_USERNAME=admin \
bun run create-admin

# 7. run the dev server
bun run dev
```

The API is now at `http://localhost:3000/api/v1`.

## Scripts

| Command                      | What it does                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `bun run dev`                | Start the dev server with `--watch` (`NODE_ENV=development`)                                     |
| `bun run typecheck`          | `tsc --noEmit`                                                                                   |
| `bun run lint`               | `eslint .`                                                                                       |
| `bun run lint:fix`           | `eslint --fix .`                                                                                 |
| `bun run format`             | `prettier --check .`                                                                             |
| `bun run format:fix`         | `prettier --write .`                                                                             |
| `bun run db:generate`        | Generate a migration from `src/db/schema/`                                                       |
| `bun run db:migrate`         | Apply pending migrations to `DATABASE_URL`                                                       |
| `bun run db:studio`          | Open [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) (DB browser UI)          |
| `bun run db:seed:mock-users` | Reset `mock_users` to a fixed set of 9 names (`seeds/mock_users.sql`)                            |
| `bun run db:seed:demo`       | **Wipes** products/suppliers/orders/notifications and loads HQ demo data (see "Demo data" below) |
| `bun run create-admin`       | One-off: create the first admin account (see "Authentication" below)                             |

## Routes

All routes are mounted under `/api/v1`, including better-auth's own routes (`/api/v1/auth/*`) — better-auth's `.mount()` still has to sit outside the `{ prefix: "/api/v1" }` group (see "Authentication" below and CONTRIBUTING.md), but its own `basePath` is configured to `/api/v1/auth` so the URL still ends up versioned the same as everything else.

| Route                                | Notes                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/health`                 | Always on — liveness check                                                                                   |
| `GET /api/v1/users`                  | HQ sees all users (filterable by `branchId`/`userType`/`search`, paginated); Branch sees only its own branch |
| `GET /api/v1/users/:id`              | Get one user, within the caller's authorized scope                                                           |
| `POST /api/v1/users`                 | Create a user — hierarchy-checked (see "Authentication" below)                                               |
| `PATCH /api/v1/users/:id`            | Update a user's profile fields                                                                               |
| `PATCH /api/v1/users/:id/deactivate` | Ban the account (blocks sign-in, kills existing sessions)                                                    |
| `PATCH /api/v1/users/:id/reactivate` | Un-ban the account                                                                                           |
| `GET /api/v1/mock/users`             | **Dev-only** (`NODE_ENV=development`) — real DB-backed reference implementation                              |
| `GET /api/v1/mock/users/:id`         | Dev-only                                                                                                     |
| `POST /api/v1/mock/users`            | Dev-only                                                                                                     |
| `GET /api/v1/mock/auth/me`           | Dev-only — demonstrates the `auth` macro, any signed-in user                                                 |
| `GET /api/v1/mock/auth/hq-only`      | Dev-only — demonstrates userType-gated `auth` macro (`hq` only)                                              |

The `mock` routes exist to show the intended architecture end-to-end (model → service → route, backed by a real `mock_users` table via Drizzle) — but they're not part of the real product schema. See [CONTRIBUTING.md](./CONTRIBUTING.md) before adding real routes.

## Authentication

[better-auth](https://better-auth.com) (`src/utils/auth.ts`), mounted at `/api/v1/auth/*` (`src/routes/auth.route.ts`) — email/password sessions, backed by the real `user`/`session`/`account`/`verification` tables (`src/db/schema/auth.ts`, merged into `user.ts`).

This is a warehouse system — accounts are provisioned by an admin, not self-service:

- Public sign-up (`POST /api/v1/auth/sign-up/email`) is disabled (`emailAndPassword.disableSignUp`).
- Beyond the bootstrap admin, accounts are created via `POST /api/v1/users` (`src/routes/users.route.ts`), not better-auth's own `POST /api/v1/auth/admin/create-user` — the custom route enforces the `userType` hierarchy (hq can create hq/branch/cashier/customer; a branch account can only create cashiers in its own branch) before calling `auth.api.createUser()` server-side. See its OpenAPI docs for the rest of the `/users` surface (list/get/update/deactivate/reactivate).
- `role` (`admin`/`user`) is a separate, mostly-unused concept from `userType` (`hq`/`branch`/`cashier`/`customer`), the business role used everywhere else (see `src/plugins/auth.plugin.ts`'s `auth` macro, gated on `userType`) — every account created via `POST /api/v1/users` keeps the better-auth default `role: "user"` on purpose, so only the bootstrap admin can reach better-auth's own `/admin/*` endpoints directly.

**Bootstrapping the first admin** — since account creation itself requires an admin, the very first one has to be created outside the HTTP layer, via `bun run create-admin` (step 6 of Setup above). Run once per environment (it checks for an existing `role: "admin"` user and refuses if one already exists). After that, sign in as this admin and use `POST /api/v1/users` (hierarchy-checked, see the route's OpenAPI docs) for every other account.

**CORS** — `CORS_ORIGIN` (env var, currently a placeholder — no frontend yet) controls both `@elysiajs/cors` and better-auth's `trustedOrigins`; they're separate mechanisms that happen to share the same value. `credentials: true` is set, so it must be an exact origin, not `*`.

**Forgot/reset password** — `POST /api/v1/auth/request-password-reset` (`{email, redirectTo?}`) emails a reset link, `POST /api/v1/auth/reset-password` (`{token, newPassword}`) applies it. The email itself is sent via `src/utils/mailer.ts` (nodemailer, config from the `SMTP_*` env vars) — locally that's Mailpit (see Docker below), so nothing is ever sent to a real inbox in dev. Resetting a password also revokes every other session (`revokeSessionsOnPasswordReset: true` in `src/utils/auth.ts`), same reasoning as `usersService.deactivate`'s session wipe.

`GET /api/v1/auth/reset-password/:token` (the link in the email) is a redirect-only endpoint, not a page — it validates the token then 302s to `redirectTo` with `?token=...` appended, for a frontend to pick up and call `POST /reset-password` itself. Without a `redirectTo` (or without a frontend to receive it), it just redirects to `/auth/error`. `redirectTo` must be a trusted origin (checked the same way as `CORS_ORIGIN`) or the request is rejected before an email is even sent.

`src/index.ts` calls `verifyMailerConnection()` on startup — it checks the SMTP connection and logs a clear success/failure line (`Mailer connected (SMTP host:port)` or `Mailer failed to connect ...`), but never blocks boot: the rest of the API doesn't depend on email working. A broken SMTP config otherwise fails **silently** per-request — better-auth swallows `sendResetPassword` errors into a generic background-task log line, so `src/utils/auth.ts` catches and logs each failure itself with the actual recipient email attached.

## Docker

`docker-compose.yml` runs four services, all on a fixed bridge network (`racha-se-network`) so a future frontend repo can join it directly (`networks: { racha-se-network: { external: true } }`):

| Service   | Host port     | Purpose                                                                                  |
| --------- | ------------- | ---------------------------------------------------------------------------------------- |
| `backend` | `6767`        | this app, built from `Dockerfile`                                                        |
| `db`      | `6969`        | Postgres 17                                                                              |
| `adminer` | `6769`        | Postgres web UI (`http://localhost:6769`, server: `db`)                                  |
| `mailpit` | `6825`/`6826` | SMTP catcher for local dev — send on `6825`, view caught mail at `http://localhost:6826` |

Ports are non-default on purpose to avoid clashing with other local projects.

```bash
docker compose up -d db adminer mailpit                   # just the dependencies (common if you're running `bun run dev` on the host instead)
docker compose run --rm backend bun run db:migrate        # apply migrations before the backend container serves traffic
docker compose up -d                                      # start everything, including the backend container
docker compose stop                                       # stop without deleting containers/volumes
docker compose down                                       # stop and remove containers + network
```

Migrations are **not** run automatically on container start — deliberately, to avoid every replica racing to migrate concurrently in a hypothetical multi-instance setup. Run `docker compose run --rm backend bun run db:migrate` (or `bun run db:migrate` from the host against the same DB) before starting `backend` against a fresh database, or `/api/v1/mock/users` will fail with "relation does not exist".

## Database

Schema lives in `src/db/schema/` ([Drizzle ORM](https://orm.drizzle.team), Postgres dialect), connected via `src/db/client.ts` using Bun's built-in `Bun.sql` (`drizzle-orm/bun-sql` driver — no extra DB driver dependency).

```bash
bun run db:generate   # after changing src/db/schema/, generate a migration into src/db/migrations/
bun run db:migrate    # apply pending migrations to DATABASE_URL
bun run db:studio     # browse the DB in Drizzle Studio
```

Migration files in `src/db/migrations/` are committed to git — never hand-edit one that's already been applied; generate a new migration instead. Triggers and other things Drizzle's schema builder can't express live in hand-written **custom migrations** (`bunx drizzle-kit generate --custom --name=<name>`) — see `0001_triggers.sql`. `seeds/triggers.sql` is a reference copy only; it's not applied to the database.

`mock_users` is a demo-only table kept separate from the real business schema (`user`, `branch`, `supplier`, `product`, `order`, ...) — it exists purely so the `/mock/users` routes can demonstrate the full DB-backed pattern. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the distinction.

`bun run db:seed:mock-users` truncates and reseeds `mock_users` with a fixed set of names (`seeds/mock_users.sql`).

## Demo data

`bun run db:seed:demo` (`scripts/seed-demo.ts`) fills a local database with an HQ catalog for frontend work and demos — 20 products, 23 stock lots, 3 suppliers, 8 categories — shaped so every HQ inventory alert has something to show. It's for local development only (it refuses to run with `NODE_ENV=production`).

```bash
docker compose up -d db
bun run db:migrate
bun run db:seed:demo
bun run dev
```

Sign in with `POST /api/v1/auth/sign-in/email` as `hq.demo@racha-se.local` / `DemoPassword123!` (a `userType: "hq"` account the script creates on first run — not an admin, so `create-admin` still works afterwards).

**Every run wipes** `product`, `product_category`, `product_category_map`, `supplier`, `order`, all three order-detail tables and `notification`, then reloads the same data; users and branches are kept. Re-run it whenever you want a clean slate. Expiry dates are relative to the moment it runs, so "expires in 3 days" is always 3 days from now.

What it produces (the script checks this itself after seeding and exits non-zero if the real inventory/notification logic disagrees):

| Endpoint                                 | Expected                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/inventory/hq`               | 21 lots (default page size is 20 — pass `limit`/`offset` to see the rest)                                      |
| `GET /api/v1/inventory/hq?groupBy=true`  | 17 products — Eggs (empty lot), Cooking Oil (never delivered) and Classic Cola (inactive) are left out         |
| `GET /api/v1/notifications/hq/min-stock` | 7 alerts: Instant Noodles, Canned Tuna, Milk Chocolate Bar, Eggs, Whole Wheat Bread, Greek Yogurt, Cooking Oil |
| `GET /api/v1/notifications/hq/expire`    | 2 alerts: Fresh Milk (one of its two lots, 3 days left) and Greek Yogurt (5 days left)                         |

Two results that look odd but are how the real logic works: Whole Wheat Bread expired 2 days ago, so it raises a **min_stock** alert (expired lots don't count as usable stock) but **no** expire alert (that alert only covers lots expiring within the next 7 days). Orange Juice expires in 10 days — just outside that window — so it has no alert yet. Prices are whole baht.

Alerts come from the real `notificationService.scanAlerts()` (the same thing `POST /api/v1/notifications/scan` runs), not hand-inserted rows — so after changing stock by hand, call that endpoint to refresh them.

## Pre-commit

`.pre-commit-config.yaml` runs at three different git stages — you must install all three (step 3 above) or some checks silently never run:

- **`pre-commit` stage** (on every `git commit`): file hygiene (trailing whitespace, large files, case conflicts, BOM, merge conflict markers, etc.) + `tsc --noEmit` + `eslint --fix` + `prettier --write`
- **`commit-msg` stage**: [commitlint](https://commitlint.js.org) enforces [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `perf:`, `revert:`, `style:`)
- **`pre-push` stage**: blocks pushing directly to `main` (local courtesy check only — bypassable with `--no-verify`; there is no server-side branch protection configured)

Run everything manually against the whole repo:

```bash
pre-commit run --all-files
```

CI (`.github/workflows/ci.yml`) runs the exact same `pre-commit run --all-files`, so nothing that passes locally should ever fail in CI, and vice versa.

## Not yet wired up

- `POST/GET/PATCH /api/v1/users*` is the only real (non-mock) route implemented so far. The rest of the business schema (`branch`, `product`, `order`, ...) only has migrations plus route/service/model scaffolding — no logic yet. The `/mock/users` and `/mock/auth` routes remain working references to copy the pattern from.

`docs/skills/` has a reference guide for Better Auth, pulled from its official skill docs.
