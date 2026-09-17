---
---

The entry-guard self-test now requires each script it runs through a symlink to reach its own `main()` by both paths: the exit code of that script's refusal and a stderr line only its `main()` prints. It previously compared the two runs with each other only, so a guard that never fired on either path passed. The mutation fixture now switches each probed guard off by both paths, makes the shared `isMainEntry` answer false for every invocation, puts back the old guards of `doc-binding.mjs`, `pr-head-gate.mjs` and `verify-publish-closure.mjs`, and breaks the exit code and the diagnostic line of the witness one at a time. Its text also states what the suite still does not cover.

Refs #1622
