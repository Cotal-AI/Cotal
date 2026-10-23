---
"@cotal-ai/cli": patch
---

`cotal persona show default` and `cotal persona edit default` read and save the default persona that `space create`, `setup` and `up` write. Its file is `default.md` and it names its agents `default_agent`, and both commands refused it with `SCHEMA_INVALID` ("persona name must match the catalog name"), as did `cotal personas edit default`. Show and edit now accept any valid definition whose `name` is not its catalog name. `persona create` still requires the file to name the persona it creates.
