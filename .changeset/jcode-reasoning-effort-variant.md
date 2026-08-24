---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-core": patch
---

`--variant` now selects a Jcode seat's reasoning effort instead of failing loud.
The connector declares `supportsModelVariant`, takes the tier from `--variant`
or a persona's `variant:`, and the host applies it to the session after the
model and before the seat's first turn — so no turn is ever served at an effort
nobody chose.

The tier is validated by Jcode, which owns the per-provider, per-model ladder
and names the accepted set when it refuses; the connector keeps no copy of it.
A rejected tier, or a model with no reasoning-effort surface, ends the launch
with that reason rather than clamping to a neighbouring effort. Omitting the
variant keeps Jcode's own configured default.
