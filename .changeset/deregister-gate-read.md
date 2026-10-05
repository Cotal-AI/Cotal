---
"@cotal-ai/manager": patch
---

`cotal deregister-instance` and the manager's clean-stop deregistration now read an instance's issuance-gate generation through core's `readEndpointGateGeneration`, as the manager's governance-slot reclaim already did, instead of a hand-rolled copy. A gate row that carries a delete marker is now refused with core's explanation (a gate is never deleted, SPEC 13.12) rather than reported as a plain "no issuance gate" absence.
