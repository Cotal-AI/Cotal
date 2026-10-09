---
"@cotal-ai/manager": patch
---

The manager's spawn provisioner connection now opens through the same `withScopedEndpoint` helper as the delivery-admin evictors and the liveness probe. Before, it built its endpoint by hand with no `error` listener, so a connection error on it, such as a broker permission violation during onboarding, ended the manager process with an unhandled `error` event, and a failed stop replaced the onboarding result or error with the stop error. The provisioner credential keeps its five-minute lifetime.
