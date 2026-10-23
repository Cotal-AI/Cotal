---
"@cotal-ai/cli": patch
---

`space forget` now removes the stopped stack definitions `cotal up` saved for the space at its root, so another folder can start a stack under the same name. When a member was not stopped cleanly, the definitions are kept and the result warns with `STACK_DEFINITIONS_KEPT`, naming the route that releases them. A bare `up` that meets another folder's stack definitions names that folder and every definition saved for it.
