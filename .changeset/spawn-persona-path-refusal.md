---
"@cotal-ai/cli": patch
---

A foreground `cotal spawn` whose persona reference is a path that does not exist now names the file it opened. It used to say the persona was missing from the mesh's `.cotal/agents` directory, which a path reference never reads. A bare catalog name is still refused with that directory and the mesh it came from. `docs/cli.md` now says how a path reference resolves.
