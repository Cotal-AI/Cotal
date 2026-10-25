---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` no longer stops at a `nats-server` on PATH that a broker start would refuse as
unprotected, such as one in a group-writable Homebrew folder on macOS, when the bundled
`nats-server` passes that check. It runs the bundled one and never runs the one on PATH, and
`cotal status` names the one it passed over and why. A protected `nats-server` on PATH is still
the one used. When the bundled one is missing or fails the same check, the broker start still
refuses, naming each folder and its fix.
