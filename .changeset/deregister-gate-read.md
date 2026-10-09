---
"@cotal-ai/manager": patch
---

`cotal deregister-instance` and the manager's clean stop read the issuance-gate generation through core's `readEndpointGateGeneration`. When the instance holds its governance slot and its gate is absent or carries a delete marker, the refusal's diagnostic text now comes from core's reader rather than a hand-rolled "no issuance gate" message. The error class is unchanged: core still wraps the reader failure as `unavailable`.
