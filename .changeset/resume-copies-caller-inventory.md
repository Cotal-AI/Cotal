---
"@cotal-ai/manager": patch
---

`Manager.resumePreserved` now copies the inventory it is handed before it starts. It copied only the share-tools selection and kept the caller's `subscribe`, `allowSubscribe`, `allowPublish` and `capabilities` arrays, so a caller that wrote to its inventory after the resume changed the resumed agent's retained launch, what the next preservation recorded and what a following resume launched with. The control op was not exposed, because it resumes a freshly parsed inventory.
