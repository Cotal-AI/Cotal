---
"@cotal-ai/cli": patch
---

A multi-name `cotal down` that names the broker as `broker` or `stack-broker` now gets the refusal `nats` gets: `TARGET_NOT_FOUND`, one message for each of the three names, and a bare `cotal down` as the next step, in a dry run, a stop and `--json`. On a controller stack those two names reached the saved `stack-broker` and refused `UNSUPPORTED` in stop-policy terms, with `<name>` and `<full-id>` placeholders. A saved service of your own named `nats` or `broker` still resolves as that service. A set that names another saved service running a broker still refuses `UNSUPPORTED`, now in plain words with that service's own stop filled in.
