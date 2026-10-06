---
"@cotal-ai/manager": patch
---

The manager's delivery-admin evictor, family evictor and freeze-holder liveness probe now open their one-call connections through one helper, `withScopedEndpoint`, which mints the 60 second credential and builds the endpoint that never joins presence, consumes or watches a channel. Before, four call sites spelled out that lifecycle by hand, so a copy that dropped its explicit lifetime would have minted an `observer` credential with no expiry and still typechecked. Shipped behaviour is unchanged.
