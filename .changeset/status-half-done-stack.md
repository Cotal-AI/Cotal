---
"@cotal-ai/cli": patch
---

`cotal status` names a controller stack that an interrupted `up` or `down` left part way, and offers
the command that finishes it first. After an `up` cut off before the manager started, status listed
the running members with no word about the missing one and offered no `cotal up`; after an
interrupted `down` it offered only a restart. It now shows `Half started` or `Half stopped` with the
members on each side, and leads Next with `cotal up --root <root>` or `cotal down --yes`. The next
`up` or `down` no longer calls the earlier operation failed when every member already runs after an
`up`, or is stopped after a `down`, and it names a member that never started.
