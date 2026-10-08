---
"@cotal-ai/manager": patch
---

The comment on the deliberate-stop capture in the manager's readiness wait, which ships in `dist/manager.js`, now states the ordering rule in three lines: `stopHandle` and `freeSlot` set the same `terminalizing` latch, so only a read taken before the backlog await and the reap tells a deliberate stop from a launch failure. It replaces a 22-line boxed warning that cited smoke cells and a re-verify procedure, which would go stale whenever the suite was renumbered. No runtime change.
