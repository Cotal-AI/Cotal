---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Automatic restarts now require proof that the previous seat's local work has ended.

The built-in PTY runtime cannot prove detached tools have stopped, so it refuses explicit `supervise` requests before launch. Pi crash recovery and recovery of older supervised records also refuse without authoritative work closure. Ordinary launches remain supported. This is a breaking safety restriction; it does not kill surviving tools or cancel remote effects.

Runtime adapters can declare `supportsWorkClosure` and provide each handle's `waitForWorkExit`. Recovery after a manager crash additionally needs a durable reference and `reapWork`. Missing, failed or timed-out proof never permits a replacement. Outstanding turns retain their existing deadline semantics rather than receiving a fabricated successful or cancelled result.
