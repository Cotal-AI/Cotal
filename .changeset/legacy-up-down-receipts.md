---
"@cotal-ai/cli": patch
---

The receipts of a legacy `cotal up` and its `cotal down` now begin with `Mesh: <space>` and end with a Next, as every other report does: `up` names `cotal spawn` and the stop, and `down` names `cotal up` to start the stack again. A bare `up` in a folder that names no space also says that it started the default space `main`.
