---
"@cotal-ai/cli": patch
---

`cotal up` names the attempt when a recovered listener fails its NATS INFO read. The read used to report every failure as a restore listener failure, so an ordinary resume that timed out printed `restore listener INFO timed out` with no attempt id. It now prints the same `<kind> attempt <id>` label as the rest of the listener proof, for example `resume attempt <id> listener INFO timed out`.
