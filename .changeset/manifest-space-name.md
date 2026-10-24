---
"@cotal-ai/cli": patch
---

A team manifest whose `space:` is not a name `cotal space create` takes, such as `bad name`, `a/b`
or `x.y`, is now refused with `SCHEMA_INVALID` when it is read, naming the file, line and name. Before,
`team check` reported it as resolved, `team boot --dry-run` gave the same partial result as for a valid
name, and `team boot` failed later with an unrelated instruction. `up -f` refuses it the same way.
