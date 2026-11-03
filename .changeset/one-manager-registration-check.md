---
"@cotal-ai/auth": patch
---

Every manager door now refuses a manager gate through one current-registration check, so it uses the same order and codes everywhere. Before, the delegated user intent doors checked the gate's principal before its open state, so a frozen gate held by another owner was refused there as `permission-denied` and as `failed-precondition` at every other door. The manager-service `renew` arm now compares the registration proof in constant time. The refusal messages now name each door the same way.
