---
"@cotal-ai/cli": patch
---

Move the up command's resume and restore-listener activation out of `up.ts` into an internal `up-resume.ts`. `up.ts` keeps every export it had, so the module surface is unchanged.
