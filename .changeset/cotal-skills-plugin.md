---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Distribute Cotal's authored Agent Skills (`SKILL.md`), starting with `team-topology`, from one canonical source in the CLI package to every AI coding harness, with real central update and removal.

- **Claude Code:** a skills-only `cotal-skills` plugin in the existing `cotal-mesh` marketplace, installed at user scope and independent of the mesh connector (it carries no code and no core dependency). Its plugin version is stamped from the running CLI release and `cotal setup` runs `claude plugin update`, so an upgrade actually replaces the cached skill; each plugin dir is rebuilt from an allowlist and swapped in, never merged, so no stale file rides in. It installs on first run and, fail-loud, on repeat runs, so upgraders are not left behind, and the install is verified via `claude plugin list --json` (exact id, scope/project, enabled, no errors, and expected version). `cotal status` gains a "Claude skills" row.
- **Every other harness** (Codex, Cursor, OpenCode, Gemini CLI, Windsurf/Devin): `cotal setup` reconciles the cross-vendor `~/.agents/skills/` directory at the file level, tracked by a validated manifest under `~/.cotal`. Cotal owns exactly each skill's `SKILL.md`: before overwriting a copy you have edited it copies your version into a fresh `SKILL.md.bak` slot (never overwriting an existing or third-party backup), and on removal deletes only that file (then the dir if it is left empty), never a whole directory, never a user's other files, and never a third-party skill. Every managed write (skill file and ownership manifest) goes through a stage-and-rename with an exclusively-created temp (so a hard-linked or symlinked path is replaced, never written through to an outside inode), and a malformed or corrupt manifest fails loud. `cotal status` reports current/stale/missing/retired for the drop and current/stale/missing/broken for the Claude plugin.
- The website Agent Skills discovery index is generated from the same canonical files and reconciled (a removed skill stops being served/indexed); a forward bet on the draft RFC, which no shipping harness consumes yet.

A corrupt or empty skills bundle fails loud rather than silently shipping zero skills.
