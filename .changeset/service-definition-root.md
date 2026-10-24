---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal service add` now saves a definition with the root of the space it is added in. A definition a
forgotten space of the same name left in another folder refuses `service start`, `restart` and
`install` there with `CONFLICT`, naming that root and `cotal service remove <name> --space <space>
--yes`, instead of running in the forgotten project's folder. `cotal service` marks such a
definition `inherited from <root>` in a new `Added in` column, `service show` lists `Added in`, and
`--json` gives each definition its `root` and `rootMatch`. A definition file that sets `root` is
refused `SCHEMA_INVALID`. Definitions saved before this release start as before and show `root not
recorded`. An earlier release refuses a definition that records a root; see the upgrading guide.
