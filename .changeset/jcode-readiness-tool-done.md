---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-core": patch
---

Prove Jcode pre-join readiness on the orientation `tool_done` event as it arrives. A seat that
already called `cotal_orientation` now joins even when that proof turn stays open. The timeout
outcome names whether the call was observed, and teardown no longer kills a functional session
just because `turn_done` is still outstanding.
