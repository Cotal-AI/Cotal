---
"@cotal-ai/manager": patch
---

`startAgent` now copies the access lists it is given before its first await: `subscribe`, `allowSubscribe` and `allowPublish`, and on a manifest launch the `resolved` lists and `capabilities`. It used to keep the caller's arrays in the launch it retains, so a caller that wrote to them after the start changed what preservation recorded and what a resume relaunched the seat with.
