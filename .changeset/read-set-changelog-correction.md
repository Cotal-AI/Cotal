---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/pi": patch
---

The 0.33.0 changelog entry "An agent now reads only the channels it lists" now carries a correction. It presented the read-set default-deny as new in 0.33.0, but that shipped in 0.28.0 with #821, so upgrading from 0.28.0 or later needs no migration for it. The correction names what 0.33.0 did change: the `cotal_send`, `cotal_leave` and pi tool text, the reworded no-default-channel refusal, doc comments, and two regression suites. `docs/release.md` now describes how to correct a released entry.
