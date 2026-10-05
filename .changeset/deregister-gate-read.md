---
"@cotal-ai/manager": patch
---

`cotal deregister-instance` and the manager's clean stop read the issuance-gate generation through core's `readEndpointGateGeneration`. A gate row that carries a delete marker is now refused with core's explanation rather than reported as "no issuance gate".
