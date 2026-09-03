---
"@cotal-ai/cli": patch
---

Seed personas into the catalog `cotal spawn` reads, and name that directory in the output.

`cotal setup` wrote `.cotal/agents/default.md` under the directory it ran in, while `cotal spawn` loads its persona from the mesh it resolves. On a machine where those differ — a shell outside any project, plus a mesh whose root is elsewhere — setup created a file spawn would never open, so `no default persona yet - run cotal setup to seed one` survived running exactly the command it named. Setup now seeds into the resolved mesh's catalog, including when that mesh was registered against a brand-new directory with no `.cotal` in it yet.

Every seed states its destination as an absolute path, and when the mesh's root is not the current directory both are shown, so the choice is visible rather than assumed. With no mesh running at all the current directory is still the answer — setup has to work before the first `cotal up` — but it says that it fell back and why. With several meshes running and none selected it refuses and asks you to pick, instead of choosing a root on your behalf.

`cotal spawn`'s refusal now names the absolute directory it searched and the mesh that directory came from, so a persona that is missing from one catalog and present in another is diagnosable from the message itself.
