---
"cotal-ai": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Add `cotal config` for personal preferences: `harness`, `persona`, `detach-key`, `color` and `editor`. Bare `config` and `config get <key>` show the value each key resolves to, where it came from and the values it outranks; `config set` and `config unset` change your defaults, or your values for one space with `--space` (`harness` and `persona` only). All four forms take `--json` and `--plain`.

- One resolver decides each key: an explicit flag, the persona's pin, the named variable (`COTAL_DEFAULT_AGENT`, `COTAL_DEFAULT_PERSONA`, `COTAL_DETACH_KEY`, `FORCE_COLOR` then `NO_COLOR`, `VISUAL` then `EDITOR`), your value for the space, your own value, then the default. `spawn` (both paths), `attach`, `personas edit` and color all read through it, so a saved harness reaches a detached spawn as the caller's default and still yields to a persona pin.
- Preferences are saved in `preferences.json` in the configuration directory, private to their owner and versioned. A write holds a lock, refuses with `CONFLICT` when the file changed after it was read, and replaces the file atomically. A file that does not validate stops every command except help and completion, naming the file; nothing resets it.
- `@cotal-ai/workspace` exports the preferences store and resolver, and `writeResult` can report a `no-op`.
