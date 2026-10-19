---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

The pid-attribution contract's doc comments, which the published `pid.js` and `pid.d.ts` carry, now state each rule and its reason without the revision history, review citations and first-person aside. The `cotal down` comment above `isAlive` points at `@cotal-ai/workspace` in place of a `lib/pid.ts` that no longer exists, and says `isAlive` is true only when the probe proves the process exists. No behavior changes.
