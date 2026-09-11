---
---

`mutation-coverage`'s executes witness now recognises a launcher imported under an alias (`import { spawnSync as run }`) and a target bound to a name before the call (`const ENTRY = join(ROOT, "scripts", "x.mjs"); execFileSync(process.execPath, [ENTRY])`), so a suite that really runs the mutated script is graded instead of refused as not reaching it. A bound name only counts inside the launcher's argument list; a name that is merely printed after an unrelated spawn stays refused. Self-test cells cover both directions plus `spawnSync("node", …)`.
