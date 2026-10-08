---
"@cotal-ai/auth": minor
---

Add an owner-bound platform supervisor authority door to the hosted auth service. It reuses native manager registration and renewal, checks a current administrative assignment, confines issuance to one owner and lifecycle, and records the registration credentials' signed permission ceilings before returning material. Recorded permissions match the authority-plane signed native set at issuance and every renewal without widening. Ending an assignment refuses new issuance but does not invalidate previously returned, unexpired registration credentials.
