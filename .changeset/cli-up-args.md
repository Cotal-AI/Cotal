---
"@cotal-ai/cli": patch
---

Move the up command's argument validation, writability checks, server and host refusals and folder-root resolution out of `up.ts` into an internal `up-args.ts`. `up.ts` re-exports `validateUpArguments`, so the module surface is unchanged.
