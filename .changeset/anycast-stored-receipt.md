---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

`cotal_anycast` no longer answers `Sent to one @<role>.` when no seat may hold the role. It now reports what the sender knows: `Request stored as seq <N> on the @<role> queue (<k> holders online at send; delivery not confirmed).`, with `<role>` spelled as the subject routes it and the count read from the roster a moment before the publish over every seat whose role routes to that queue, never counting the sender, and `holders unknown at send` while the presence view is not current. `CotalEndpoint.anycastAttributed` returns the JetStream publish ack alongside the message, the way `unicastAttributed` does; `anycast` keeps its signature, and `routeToken` is exported so a caller can name the queue a role routes to.
