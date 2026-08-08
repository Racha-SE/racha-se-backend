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

# 4. start Postgres + Adminer
docker compose up -d db adminer

# 5. run database migrations
bun run db:migrate

# 6. run the dev server
bun run dev
```

The API is now at `http://localhost:3000/v1`.

## Scripts

| Command                      | What it does                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `bun run dev`                | Start the dev server with `--watch` (`NODE_ENV=development`)                            |
| `bun test`                   | Run the test suite                                                                      |
| `bun run typecheck`          | `tsc --noEmit`                                                                          |
| `bun run lint`               | `eslint .`                                                                              |
| `bun run lint:fix`           | `eslint --fix .`                                                                        |
| `bun run format`             | `prettier --check .`                                                                    |
| `bun run format:fix`         | `prettier --write .`                                                                    |
| `bun run db:generate`        | Generate a migration from `src/db/schema/`                                              |
| `bun run db:migrate`         | Apply pending migrations to `DATABASE_URL`                                              |
| `bun run db:studio`          | Open [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) (DB browser UI) |
| `bun run db:seed:mock-users` | Reset `mock_users` to a fixed set of 9 names (`seeds/mock_users.sql`)                   |

## Routes

All routes are mounted under `/v1`.

| Route                    | Notes                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `GET /v1/health`         | Always on — liveness check                                                      |
| `GET /v1/mock/users`     | **Dev-only** (`NODE_ENV=development`) — real DB-backed reference implementation |
| `GET /v1/mock/users/:id` | Dev-only                                                                        |
| `POST /v1/mock/users`    | Dev-only                                                                        |

The `mock` routes exist to show the intended architecture end-to-end (model → service → route, backed by a real `mock_users` table via Drizzle) — but they're not part of the real product schema. See [CONTRIBUTING.md](./CONTRIBUTING.md) before adding real routes.

## Docker

`docker-compose.yml` runs three services, all on a fixed bridge network (`racha-se-network`) so a future frontend repo can join it directly (`networks: { racha-se-network: { external: true } }`):

| Service   | Host port | Purpose                                                 |
| --------- | --------- | ------------------------------------------------------- |
| `backend` | `6767`    | this app, built from `Dockerfile`                       |
| `db`      | `6969`    | Postgres 17                                             |
| `adminer` | `6769`    | Postgres web UI (`http://localhost:6769`, server: `db`) |

Ports are non-default on purpose to avoid clashing with other local projects.

```bash
docker compose up -d db adminer                          # just the DB (common if you're running `bun run dev` on the host instead)
docker compose run --rm backend bun run db:migrate        # apply migrations before the backend container serves traffic
docker compose up -d                                      # start everything, including the backend container
docker compose stop                                       # stop without deleting containers/volumes
docker compose down                                       # stop and remove containers + network
```

Migrations are **not** run automatically on container start — deliberately, to avoid every replica racing to migrate concurrently in a hypothetical multi-instance setup. Run `docker compose run --rm backend bun run db:migrate` (or `bun run db:migrate` from the host against the same DB) before starting `backend` against a fresh database, or `/v1/mock/users` will fail with "relation does not exist".

## Database

Schema lives in `src/db/schema/` ([Drizzle ORM](https://orm.drizzle.team), Postgres dialect), connected via `src/db/client.ts` using Bun's built-in `Bun.sql` (`drizzle-orm/bun-sql` driver — no extra DB driver dependency).

```bash
bun run db:generate   # after changing src/db/schema/, generate a migration into src/db/migrations/
bun run db:migrate    # apply pending migrations to DATABASE_URL
bun run db:studio     # browse the DB in Drizzle Studio
```

Migration files in `src/db/migrations/` are committed to git — never hand-edit one that's already been applied; generate a new migration instead. Triggers and other things Drizzle's schema builder can't express live in hand-written **custom migrations** (`bunx drizzle-kit generate --custom --name=<name>`) — see `0001_triggers.sql`. `seeds/triggers.sql` is a reference copy only; it's not applied to the database.

`mock_users` is a demo-only table kept separate from the real business schema (`user`, `branch`, `supplier`, `product`, `order`, ...) — it exists purely so the `/mock/users` routes can demonstrate the full DB-backed pattern. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the distinction.

`bun run db:seed:mock-users` truncates and reseeds `mock_users` with a fixed set of names (`seeds/mock_users.sql`). `bun test` writes to this same table but tracks and deletes only the rows it creates (see [Testing](#testing)) — seeded/unrelated rows aren't touched.

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

## Testing

```bash
bun test
```

Tests live under `test/`, mirroring `src/`'s structure (not colocated). Route tests build a minimal Elysia instance (`errorHandler` + the route under test) via `app.handle(new Request(...))` — no real network calls, no server actually listening.

## Not yet wired up

- `better-auth` is installed as a dependency but not configured — no auth setup in this repo yet.
- No real (non-mock) routes exist against the business schema (`user`, `branch`, `product`, `order`, ...) yet — only migrations for it. The `/mock/users` routes are a working DB-backed reference to copy the pattern from, not real endpoints.

`docs/skills/` has a reference guide for Better Auth, pulled from its official skill docs, for when that work starts.
