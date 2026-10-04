---
---

The start-model preflight smoke now asserts that Hermes declares `supportsResume` and builds its fork launch for `spawn --resume`, which it has done since it gained session forking. The smoke still asserted that Hermes refused resume, so the manager's `test` script failed on two rows. OpenCode and the smoke's own connector without resume keep the refusal coverage. This changes test tooling only; no published package changes.
