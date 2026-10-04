---
"@cotal-ai/connector-core": patch
---

Specify the platform control authority contract in SPEC §13 and a design record: a closed `platform-control` view, beside the unchanged human `manager-service` view, that would let a host run one pooled control manager per assigned account without a human session. It reuses the registration proof, process epoch and all-duty renewal unchanged, confines its host-owned maintenance to the assigned instance, and refuses human tokens, takeover of another owner's instance, local or custodial runtime, generic signing and cross-owner descendants. This is a contract change only. No issuer, door or runtime path ships yet.
