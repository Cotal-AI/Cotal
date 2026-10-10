---
"@cotal-ai/connector-core": patch
---

The CLI reference now says what running `pnpm cotal` from a dev clone needs: a `pnpm build` first, because `bin/` loads the other packages from their built `dist/`, and `COTAL_SKIP_CONNECTOR_SEED=1` for everyday commands, which otherwise refuse the operator-global seed store from a checkout. It also notes that pointing `XDG_CONFIG_HOME` at a scratch dir is not enough on its own. Docs only.
