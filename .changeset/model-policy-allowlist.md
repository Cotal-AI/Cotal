---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

The cotal config accepts a `modelPolicy` that names, per role, the models (and optionally the variants) a seat in that role may launch on. The manager refuses a detached spawn, and `cotal spawn` refuses a foreground one, before anything is minted when the effective role has an entry and the effective model is missing or not on its list, or its variant is missing or off a declared variants list, or the launch carries launch options (from `launchOptions:` or `--opt`), which the connector applies unread after the model and which can select another model. Ids compare whole, so `vendor/model-B-fast` does not satisfy `vendor/model-B`. The refusal names the persona, whether the value came from its own `model:` or `variant:` field or from `--model` or `--variant`, the value found, and the values allowed. Roles without an entry are unconstrained, a space-local entry replaces the operator-level entry for the same role, and a malformed policy (including an unsupported field of any name) fails the spawn loudly. Before this, a persona pinned to a superseded model, or to none, launched on it with no report.
