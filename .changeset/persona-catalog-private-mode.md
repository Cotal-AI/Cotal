---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Create a missing persona catalog `.cotal/agents` with mode 0700 from every writer. Under a
group-writable umask, `space create`, `up` and `setup` made it 0775 while seeding the default
persona, so until the first `persona create` tightened it, a group member could replace
`default.md`. The setup log's `.cotal` is created 0700 the same way. An existing directory keeps
its mode.
