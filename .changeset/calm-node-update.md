---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Self-update refuses releases that cannot run on the current Node version before replacing the CLI.
Check the target release's Node engine range during release preflight, and document an explicit latest install with strict engine checking so npm cannot silently select an old release.
