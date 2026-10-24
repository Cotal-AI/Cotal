---
"@cotal-ai/cli": patch
---

`cotal reset store` and `cotal reset space` name what is wrong with a target that has nothing to reset. A name no space has refuses `TARGET_NOT_FOUND` saying no registered or prepared space has that exact name, and names `cotal space` before the legacy-root step. A prepared space no stack has run for refuses `TARGET_NOT_FOUND` naming its root, `cotal up` and `cotal space forget`. Both used to say the reset needs a space this machine started and lead with the legacy-root step.
