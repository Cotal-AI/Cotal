---
"@cotal-ai/delivery": patch
---

The delivery daemon's transport health no longer assigns `expired = false` on a reconnect. The assignment ran only after the guard that returns while a credential expiry is pending, so it always wrote `false` over `false` and read as if a reconnect cleared an expiry. Only a proved credential adoption clears it, as before. Behavior is unchanged.
