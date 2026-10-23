---
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

Host service endpoints from the stock CLI. `cotal up --user-auth --service-endpoints` passes `--service-endpoints` to the auth service, which opens the service endpoint engine, the public `/service-endpoint-authority` door and the new authenticated `/service-endpoint-host` route. That route authenticates the caller's IdP token and derives the granter itself: `decide`, an `owner-request` revoke and the reads run as the proved owner on either face; `name-bind`, any other revoke and the admission operations are the operator's and are served on the loopback face under the exchange capability only, with the proved subject as the audit id. The body never carries a granter. The engine now serves the `name-read` the host contract already declared, scoped to the owner's own binding. `cotal service-endpoint approve|refuse|proposal|operation|name|name-bind` drives the route as the signed-in user: a decision reads the proposal, with the name binding that read carries, and decides at those revisions. Without the flag nothing changes: the engine stays off and both routes answer 404.
