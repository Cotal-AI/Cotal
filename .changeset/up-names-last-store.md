---
"@cotal-ai/cli": patch
---

A start that names no store no longer opens an empty second store over data `down` stopped
tracking. After `backup restore --store-dir` and a plain `down`, `up` and `up -f` opened a new
`.cotal/nats` and left the restored messages unused in the other store, with no warning. They now
refuse `CONFLICT` and name the store the last broker served, and `up -f` accepts `--store-dir` to
reopen it.
