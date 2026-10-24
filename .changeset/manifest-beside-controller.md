---
"@cotal-ai/cli": patch
---

`cotal up -f` on a root whose records hold a controller stack now refuses `CONFLICT` before anything starts, and so does its dry run. The refusal names `cotal team deploy <file>` for the running stack, and `cotal down --yes`, then `cotal team boot <file>`. On a stopped controller stack it used to start a legacy manifest stack beside it, which `cotal down` then could not stop; on a running one it refused with an unrelated reason.
