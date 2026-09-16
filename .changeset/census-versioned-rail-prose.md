---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

Keep the versioned rail's subject token out of source comments

The issued-profile census scans every shipped source for the versioned rail's subject token and
allows only core's subject and grant builders to spell it. Five comments in core, the CLI and the
runtime spelled the token and failed that cell on main. They now say "the versioned rail" or "the
versioned plane". No code changes.
