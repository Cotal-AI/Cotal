---
"@cotal-ai/cli": patch
---

The `cotal config set --user` and `unset --user` receipt now gives the effective value a command here uses, through the selected space or the folder's, as `spawn` resolves it. It used to give your defaults' value, such as "Effective value: pi" while `spawn` used the space's `opencode`. When that space's value outranks the one you wrote, the receipt warns with `PREFERENCE_SHADOWED`, and a `persona` that space's catalog does not hold warns with `PERSONA_NOT_FOUND`, as a write without `--user` does.
