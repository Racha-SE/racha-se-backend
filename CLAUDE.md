# Instructions for Claude Code

- Do not add a `Co-Authored-By` trailer (or any "Generated with Claude Code" footer) to git commits in this repo.
- See [README.md](./README.md) for setup and [CONTRIBUTING.md](./CONTRIBUTING.md) for architecture and coding conventions — read both before making changes.
- `skill-lock.json` pins the Claude Code skills this repo relies on (better-auth, elysia), hashed against the upstream `SKILL.md` files. `AGENTS.md` + `docs/skills/*.md` are a manual mirror of the same guidance for Codex (or any agent without native skill-loading) — if `skill-lock.json` gets re-locked to a new hash, re-copy the corresponding file into `docs/skills/` so the two stay in sync. See `AGENTS.md` for details.
