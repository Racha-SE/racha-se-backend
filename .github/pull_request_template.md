## Summary

<!-- What changed and why, as bullet points. One line each where possible. -->

-

## Test plan

<!-- What you actually ran/verified, not just what should theoretically work. -->

- [ ] `bun run typecheck` / `bun run lint` / `bun run format` — all clean
- [ ] `pre-commit run --all-files` — all hooks pass
- [ ] `bun test` — all pass
- [ ] Reviewer should also run `bun run db:migrate && bun test` locally against `docker compose up -d db` to confirm
