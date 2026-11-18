---
"@cotal-ai/cli": patch
---

`cotal status` in the folder of a static-auth space stopped with `cotal down` now lists `cotal up` first under Next. It used to lead with `cotal spawn` and `cotal ps`, which both fail until the space is started again.
