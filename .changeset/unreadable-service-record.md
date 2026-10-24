---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A service instance record left truncated or overwritten made `up`, `down`, `service` and `reset store`
refuse "local record input is not valid UTF-8 JSON" with no file and no next step, while `status`
called the space stopped and suggested `cotal up`. Saved local records that are not valid JSON are
now refused with their path and the `mv` that moves them aside, and are left as they are. For a
stopped space, `status` warns about the record and gives that step under Next in place of `cotal up`.
