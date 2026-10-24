---
"@cotal-ai/cli": patch
---

`COTAL_DEBUG` and `COTAL_COMPLETE_DEBUG` now read `0`, `false` and `off`, in any case, as off, as an
empty value already was. Before, any of those turned stack traces and completion errors on.
