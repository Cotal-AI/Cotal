---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Fix the second spawn of any persona being unmintable under per-user auth.

In user mode the allocated agent name IS the mesh actor, and the principal grammar reserves `-` as
the separator of the JetStream-name form, so it is rejected inside a token. The spawn auto-numbering
scheme appended its counter with exactly that character: the second live instance of a persona was
named `<base>-2` and could never be granted. It numbers with `_` now.

The failure was invisible outside per-user auth, because static/open mode keys the actor on the
freshly minted nkey rather than on the name — so it fired only on hosted meshes, only from the
second spawn onward, and looked like a problem with one persona's name rather than with numbering.

The name rule itself now lives in one exported predicate (`spawnNameError`) that both the manager's
name door and the numbering are checked against, and whose narrow half delegates to the shipped
token validator instead of restating its alphabet. In user mode a name that could never become an
actor is refused where it is chosen, rather than at mint. Static/open mode keeps the looser rule, so
an existing `my-agent` persona still spawns across an upgrade.
