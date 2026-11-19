---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal up` starts again on a host with no machine identity, such as a container image with no `/etc/machine-id`. Release 0.169.0 refused there after starting the broker, because it recorded process pins that need that identity. Such a host now records no pins and its stack is stopped as it was before 0.169.0.
