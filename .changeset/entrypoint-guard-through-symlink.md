---
---

Repository scripts now decide whether they were run or imported by comparing resolved paths, so a script reached through a symlink executes its `main()` instead of exiting 0 having done nothing. Both attribution gates, the operator-literal scanner, and the release and CI scripts under `scripts/` share one `isMainEntry` helper, and a self-test invokes each spawnable one through a real symlink and requires the same exit code and output as its real path.

Refs #1622
