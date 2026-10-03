---
"@cotal-ai/lang": patch
---

Keep the simulator in step with a program running behind the worker bridge. The bridge now reports when the thread has reacted to every message it was sent, and `SimHandler` waits for that before delivering its next wake, so a bridged simulation settles a `race` on the arm that finished first instead of the one declared first. Handlers gain an optional `useQuiescence` hook for this, and `RecordingHandler` forwards it, so a wrapped simulator keeps the same pacing. It returns a release that the bridge calls when it closes, including when the worker fails to start, so a `SimHandler` used for one bridged run can be reused for another run afterwards.
