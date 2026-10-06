---
"@cotal-ai/manager": patch
---

The roster file that `cotal supervise --roster` reads is now documented in `docs/define-a-team.md` under "Roster files", which lists every key an entry takes: `name`, `agent`, `role`, `config`, `cwd` and `share-tools`. `docs/deploy.md` and the `--roster` row in `docs/cli.md` point there. The roster template and the deploy README no longer say an entry maps to the removed `cotal start`; they say each entry starts one agent the way `cotal spawn --detach` does and point at the docs section instead of keeping their own key lists. No behavior changes.
