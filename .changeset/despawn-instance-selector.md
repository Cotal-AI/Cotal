---
"@cotal-ai/connector-core": patch
---

`cotal_despawn` takes an optional `instance`, the manager that runs the named peer, as `cotal_spawn` does. In a space with several managers, a session no manager launched could not stop a peer: the manager selection refused and asked for an instance argument the tool did not have. The pin follows `cotal_spawn`'s rules: a seat bound to one manager cannot name another, a pin is never replaced by another manager, and `instance` without `name` is refused. A despawn without `instance`, and self-despawn, are unchanged.
