# Work log

- Started repair-843-r2 investigation: reproducing the reported closed-input failure before changing code.
- Read the supplied verdict. Red reproduction added to the live managed Jcode stdio MCP/private Unix relay smoke: JSON-own `__proto__` ran `cotal_inbox`, returned the buffered `prototype-key witness`, and a following ordinary read returned `No pull-only messages.` (`pnpm smoke:jcode-host`, bare rc 1). This proves the reported destructive closed-input bypass before the source fix.
- Fixed the shared parser's raw-own-key preflight and the Jcode stdio decode boundary, then added live bridge witnesses for `__proto__`, `constructor`, and `prototype`; green run of the managed host smoke passed 18 checks. Full `pnpm typecheck` and all Jcode/closed-input smokes passed before committing `d2266a2e`.
