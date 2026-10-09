---
"@cotal-ai/auth": minor
---

`POST /manager-service-authority` now applies the exchange face's refusal budgets, as `POST /exchange` does. A missing or wrong loopback capability counts in the invalid-capability window, and a refused IdP token or request counts against the face's refused-exchange budget, per peer on the public face. After 30 refusals in a minute a further refusal answers 429, where the route used to answer 401 or 403 without limit. `ManagerServiceAuthorityCtx` now requires the `failures` and `badCaps` windows, so a host that builds it without them no longer compiles; see the upgrading guide.
