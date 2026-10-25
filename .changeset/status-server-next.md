---
"@cotal-ai/cli": patch
---

`status --server` at an address nothing answers at, other than the one recorded for the space, no
longer offers `cotal up --root` to restart the stack's stopped members while that stack runs. Its
Next names the address that did not answer and the recorded broker, as the refusal of other
commands does. A stack member whose process is gone still leads with `up --root`.
