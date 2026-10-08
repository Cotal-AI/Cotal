---
"@cotal-ai/auth": minor
---

Add an owner-bound platform supervisor authority door to the hosted auth service. It reuses native manager registration and renewal, checks a current administrative assignment, confines issuance to one owner and lifecycle, and records the registration credentials' signed permission ceilings before returning material. Recorded permissions match the authority-plane signed native set at issuance and every renewal without widening. `endPlatformSupervisorAssignment(owner)` ends an assignment the host recorded `ended`: it retires the manager gate and the issued generations, so registration, activation and renewal refuse previously returned material by name before it expires.
