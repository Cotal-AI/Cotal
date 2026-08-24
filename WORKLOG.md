# Work log

- Started repair-843-r2 investigation: reproducing the reported closed-input failure before changing code.
- Read the supplied verdict. Red reproduction added to the live managed Jcode stdio MCP/private Unix relay smoke: JSON-own `__proto__` ran `cotal_inbox`, returned the buffered `prototype-key witness`, and a following ordinary read returned `No pull-only messages.` (`pnpm smoke:jcode-host`, bare rc 1). This proves the reported destructive closed-input bypass before the source fix.
- Fixed the shared parser's raw-own-key preflight and the Jcode stdio decode boundary, then added live bridge witnesses for `__proto__`, `constructor`, and `prototype`; green run of the managed host smoke passed 18 checks. Full `pnpm typecheck` and all Jcode/closed-input smokes passed before committing `d2266a2e`.
- Final gates passed on `77d321bf49955f003847192495f540f70af6ebed`: `pnpm typecheck`; Jcode args/host/private-state/route-identity/session-resume/security smokes; shared closed-input smoke; `git diff --check`; mutation proof killed all four declared mutations, including the new JSON-own prototype-key guard. Pushed `repair-843-r2` to `origin/fix/jcode-inbox-peek`.
