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

# 5. run the dev server
bun run dev
```

The API is now at `http://localhost:3000/v1`.

## Scripts

| Command              | What it does                                                 |
| -------------------- | ------------------------------------------------------------ |
| `bun run dev`        | Start the dev server with `--watch` (`NODE_ENV=development`) |
| `bun test`           | Run the test suite                                           |
| `bun run typecheck`  | `tsc --noEmit`                                               |
| `bun run lint`       | `eslint .`                                                   |
| `bun run lint:fix`   | `eslint --fix .`                                             |
| `bun run format`     | `prettier --check .`                                         |
| `bun run format:fix` | `prettier --write .`                                         |

## Routes

All routes are mounted under `/v1`.

| Route                    | Notes                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `GET /v1/health`         | Always on — liveness check                                                      |
| `GET /v1/mock/users`     | **Dev-only** (`NODE_ENV=development`) — reference implementation, not real data |
| `GET /v1/mock/users/:id` | Dev-only                                                                        |
| `POST /v1/mock/users`    | Dev-only                                                                        |

The `mock` routes exist purely to show the intended architecture (model → service → route). See [CONTRIBUTING.md](./CONTRIBUTING.md) before adding real ones.

## Docker

`docker-compose.yml` runs three services, all on a fixed bridge network (`racha-se-network`) so a future frontend repo can join it directly (`networks: { racha-se-network: { external: true } }`):

| Service   | Host port | Purpose                                                 |
| --------- | --------- | ------------------------------------------------------- |
| `backend` | `6767`    | this app, built from `Dockerfile`                       |
| `db`      | `6969`    | Postgres 17                                             |
| `adminer` | `6769`    | Postgres web UI (`http://localhost:6769`, server: `db`) |

Ports are non-default on purpose to avoid clashing with other local projects.

```bash
docker compose up -d             # start everything, including the backend container
docker compose up -d db adminer  # just the DB (common if you're running `bun run dev` on the host instead)
docker compose stop              # stop without deleting containers/volumes
docker compose down              # stop and remove containers + network
```

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

`better-auth` and `drizzle-orm`/`drizzle-typebox` are installed as dependencies but not yet configured — there is no database schema or auth setup in this repo yet. `docs/skills/` has reference guides for both, pulled from their official skill docs, for when that work starts.
