# Agent instructions

This project pins a set of Claude Code skills in `skill-lock.json`. Codex (and
any other agent without native skill-loading) doesn't read that file, so the
same guidance is mirrored here as plain docs — read the relevant one before
touching related code.

| When you are...                                                                          | Read                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| Configuring Better Auth server/client, database adapters, sessions, plugins, or env vars | `docs/skills/better-auth-best-practices.md` |
| Scaffolding new auth (login, sign-up, OAuth) from scratch                                | `docs/skills/create-auth-skill.md`          |
| Writing or modifying Elysia routes/plugins/schemas                                       | `docs/skills/elysiajs.md`                   |

These are verbatim copies of the upstream `SKILL.md` files referenced in
`skill-lock.json` (same `computedHash`). If `skill-lock.json` is re-locked to
a newer hash, re-copy the corresponding file here so the two stay in sync.

`docs/skills/` is excluded from the `trailing-whitespace` and
`end-of-file-fixer` pre-commit hooks (and from Prettier, via
`.prettierignore`) specifically so nothing in the toolchain silently
rewrites these files and breaks the `computedHash` match.
