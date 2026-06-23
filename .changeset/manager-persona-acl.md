---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

fix(manager): spawn by persona filename, identity from the file's `name:`

A manager spawn (`start` op / `cotal_spawn` / roster boot) resolved the persona by the spawn
name but, on a miss, silently minted default creds (read `general` only, default-deny publish, no
capabilities) — so a persona spawned by its display name, a typo, or a renamed file became a live
agent with silently-wrong ACLs. The manager now matches `cotal spawn`: the argument is a persona
ref (a filename in `.cotal/agents`, the unique key), the mesh identity comes from the file's
`name:` (auto-numbered on collision), a missing persona fails loud, and the read/post ACL is always
provisioned from the loaded persona — never a default.
