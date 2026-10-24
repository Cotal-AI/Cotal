---
"@cotal-ai/auth": minor
---

`POST /exchange` now answers a `manager-caller` exchange with `token`, `owner` and `exp`, the fields `ExchangeResult` declares. The IdP bridge also returned `managerInstanceId` through a spread the type did not check, and the agent exchange sent it too, but no client read it. A `manager-caller` bearer's instance is its signed `act.managerInstanceId` claim, which the callout enforces and the CLI reads. Code that read the response field reads that claim instead.
