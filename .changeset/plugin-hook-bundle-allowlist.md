---
---

The committed Claude Code plugin under `claude-plugin/cotal` is rebuilt from current source, and the operator-literal allowlist drops its two `dist/hook.cjs` entries. The hook bundle stopped carrying the docs when `cotal_docs` began building them on first call, so a rebuild left zero of the four allowlisted literals in it and the release pull request failed the attribution gate with the allowlist graded broken. The `dist/mcp.cjs` entries keep their counts. This changes repository tooling and the committed plugin tree only; no published package changes.
