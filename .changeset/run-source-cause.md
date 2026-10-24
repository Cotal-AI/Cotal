---
"@cotal-ai/runtime": patch
---

A `run` verb given a workflow source it cannot read now names the path and the cause: it does not
exist, it is a link whose target does not exist (`TARGET_NOT_FOUND`), it is a directory
(`USAGE_INVALID`), or it is not readable (`PERMISSION_DENIED`). `-` is read as a path, and its
refusal says that it does not mean standard input.
