---
"@cotal-ai/cli": patch
---

Prepare or start another space without running `cotal setup` again.

- `cotal space create` and an `up` that starts or refreshes a local space write the `default` persona into the space's `.cotal/agents` when it has none, as setup does. A persona you edited is left as it is. `space create --json` and a controller `up --json` list the write under `result.written`.
- `cotal setup` also saves the application as your own `harness` preference when you have none, so a space you prepare later uses it. A value you already set stays.
- With the default persona missing, `cotal status`, `cotal spawn` and `cotal app-identity` name the command that writes it: `cotal up` in the root of a space this machine started, or `cotal persona create default` for any other space. An invalid default points to `cotal persona show default`.
- The `cotal space` listing suggests `cotal space create` and `cotal space add` for another space.
- `cotal up` with no `--space` in the folder of a running open space runs that space again. It used to resolve the default space and refuse. A folder whose stack and registrations name several spaces refuses with `CONFLICT` and asks for `--space`. The refusal for another space in a space's own folder names `cotal up --space <name>` instead of telling you to drop a flag.
