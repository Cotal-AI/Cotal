---
"@cotal-ai/cli": patch
---

Move the manager stop-impact facts that `status --components` prints out of `status.ts` into an internal `status-stop-impact.ts`, so `status.ts` is back under its recorded size. The output is unchanged.
