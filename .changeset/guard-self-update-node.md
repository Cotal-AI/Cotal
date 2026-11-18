---
"@cotal-ai/cli": patch
---

Self-update refuses releases that require an incompatible Node.js version before replacing the working installation.
The updater checks declared Node ranges during release preflight. Installation instructions use the explicit latest tag with strict engine checking so an older Node cannot silently select an old release.
