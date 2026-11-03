---
"@cotal-ai/auth": patch
---

The manager-service `retire` arm now checks the manager gate with the same shared check as every other manager door. It refuses with the same codes in the same order, and its message for a gate held by another principal now uses the same wording as the other doors.
