---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A manager can be given a name when it starts: `cotal supervise --name <name>`, the `manager`
service preset's `name` option, or `cotal up --manager-name <name>`. The name rides the manager's
presence card and is recorded in its root, so a restart or repair keeps it. `who --all` and the
choice listed when several of your managers are live show each manager by its name, or by
`<host>/<runtime>` when it has none. On a user-auth mesh, `--on` takes a manager's name or host as
well as its instance id when only one of your live managers matches it, and otherwise refuses
and lists them with the command again on each. On a static or open mesh a name passed to `--on` is
refused with a Next that asks for the instance id.
