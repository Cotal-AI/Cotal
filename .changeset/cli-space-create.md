---
"cotal-ai": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`cotal space create <name> [--root <dir>]` prepares a space to start on this machine.

- It records the name and root, and makes `<root>/.cotal/`, so `cotal up` in that root starts the space under that name and drops the prepared record. It starts nothing and keeps the selection. It refuses with `CONFLICT` a name that is registered or prepared, a folder that is already a space's root, and the home folder.
- `cotal space` lists prepared spaces under their own heading, and `cotal space show`, `cotal use` and `cotal space forget` accept one. `cotal space add` refuses a prepared name.
- A command that targets a prepared space refuses with `TARGET_UNAVAILABLE`, naming the root to start it in, before anything dials an address. `cotal up --space <name>` from another folder refuses before it writes anything.
- `@cotal-ai/workspace` keeps prepared spaces in their own store under `~/.cotal/prepared`, apart from the mesh registry, and target resolution reports one with the `not-started` code.
