# Jcode readiness stabilization worklog

## 2026-08-24 — started

- Commissioned for public issues #777, #778, and #779: jcode connector readiness ordering, post-join context, and early TUI stabilization.
- Required next action: read all three issue threads, reproduce each defect live before changing code, then implement only verified fixes with smoke cells and mutation proof.
- Issue tracker read: #777 confirms an intermittent Jcode MCP registration/tool-snapshot race; #778 records stale pre-join orientation text in context; #779 records TUI creation after the readiness LLM turn.
- `gh issue view` is currently blocked by GitHub's Projects Classic GraphQL deprecation; obtained the same issue records and comments through `gh api`.
- Board binding lookup was refused (`no-current-binding`), so no board run can be opened until a human binds this lane.

## 2026-08-24 — implementation and evidence

- Reproduced #777 with the harness fake delaying `cotal_orientation` until Jcode's second readiness turn. Baseline (pre-fix) exited 1 after a single readiness request; the repaired host joins only after exactly one retry. A never-callable bridge gets exactly two requests, exits non-zero, and never enters the roster.
- Reproduced #779 with a foreground fake TUI and delayed readiness completion. Baseline placed TUI after `orientation_done`; fixed host places it before the proof completes.
- Reproduced #778 by asserting the post-`await agent.start()` no-reply session notice that marks bootstrap orientation as pre-join and directs the seat to request live orientation.
- Implemented bounded readiness retry, early TUI spawn, post-join context notice, `docs/connect-jcode.md` update, a fixed-group patch changeset, and `extensions/connector-jcode/smoke/mutations/jcode-readiness.json`.
- Evidence: `pnpm smoke:jcode-host` passed 19 checks; `pnpm build && pnpm typecheck` passed; readiness mutation proof killed M1–M4 against their named cells; `pnpm changeset status` reports the fixed group at patch.
- Commits: `6c13f38c`, `403e7c94`, `72feb90d`, `c6ba73e7`.
- Pushed `fix/jcode-readiness-stabilization`; opened PR #845 at exact SHA `c6ba73e7b266f32db84fe37380f5c07c5462f1c7`.
