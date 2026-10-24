---
"@cotal-ai/cli": patch
---

A refusal for a space name no space has no longer heads its report `Mesh: <name>`. `space create`
of a name it refuses, and `space show` and `space forget` of a name that is not registered or
prepared, carry the name as `target.requested` instead of `target.space`. `meshes add` and
`space add` now refuse a name `space create` refuses, such as `a*b`, with `USAGE_INVALID`, even with
`--force`. A mesh an earlier release registered under such a name still lists, shows and removes as
before.
