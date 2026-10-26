---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A manager can now bound how many live seats it holds for one owner, so a manager shared by several
owners cannot be filled by the first one to ask. `cotal supervise --seat-cap <n>` and `cotal up
--seat-cap <n>` set it, and the value is recorded in the root, so a repair, a resume or a bare `up`
after `down` keeps it. The default is `unlimited`, which leaves the manager's own 50-slot ceiling as
the only bound, so a mesh with one owner keeps every slot it had. The cap counts the seats that
manager supervises for the owner a launch belongs to, plus its launches that have no process yet;
it does not count cooling slots or another owner's seats.

A launch over the cap is refused before a name is reserved or anything is minted, and the seats
already running are untouched. The refusal is `resource-exhausted` carrying the owner, its count and
the cap, so a caller reads the numbers rather than the sentence. `cotal spawn` exits 2 with
`CONFLICT`, the manager's sentence and a remedy naming `cotal stop --name <name>` and `--seat-cap`;
under `--json` those three numbers are in `error.cause.detail`. `cotal_spawn` shows an agent the same
sentence. Stopping one of that owner's seats admits the next launch.
