---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Register, list and unregister meshes from the CLI.

`cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open]` records a mesh this
machine did not start — one running on another machine, a shared broker, a hosted space — so
`--space`, `cotal use` and a bare `cotal spawn` can reach it from any directory. The broker is
probed before anything is written, so a wrong address or credentials that mesh will not accept fail
at registration instead of at the first spawn; `--force` records unverified and replaces an existing
record. `cotal meshes rm <space> …` drops records (never stopping a mesh: a mesh running here is
refused in favour of `cotal down`) and releases the `current` pointer when it pointed at one.

Registry records now carry an origin, and an automatic prune only ever deletes records that
`cotal up` wrote. A record added by hand cannot be reconstructed by this machine, so an unreachable
broker under one is reported — `offline` in `cotal meshes`, and a preflight failure that names
`cotal meshes rm` rather than `cotal up` — instead of silently unregistering a mesh that was live
all along.
