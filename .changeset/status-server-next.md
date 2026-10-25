---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

In open or static-auth mode, `status --server` at an unreachable address other than the recorded
one no longer offers `cotal up --root` to restart the stack's stopped members while that stack runs. Its
Next names the address that did not answer and the recorded broker, as the refusal of other
commands does. A stack member whose process is gone still leads with `up --root`.
