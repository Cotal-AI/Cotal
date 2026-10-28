---
"@cotal-ai/auth": patch
---

`POST /interactive-lifecycle/retire`, `POST /managed-lifecycle/retire` and `POST /manager-service-authority/verify-enrollment` count a missing or wrong loopback capability in the same invalid-capability window as `POST /exchange`. The first 30 in a rolling minute answer 401 with the route's own reason, and a further one answers 429. Each refusal is logged. A correct capability is unchanged. The interactive retirement route still states `outcome: "not-executed"` on that refusal, because nothing was retired.
