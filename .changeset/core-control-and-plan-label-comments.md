---
"@cotal-ai/core": patch
---

The hover docs for `CotalEndpoint.serveControl` and `requestControl` no longer describe manager control tiers, a manager wildcard reply grant or an agent-credential cutover that no longer exist. They now name the delivery daemon's `ctl.delivery.*.*.reply.>` grant as the reason `boundReply` is required, and the `CONTROL_DELIVERY` and `requestDelivery` docs match the bounded reply both control requests use. Comments on the session ledger, goal-writer, caller grant, invoke, endpoint-serve ledger, lease and slot-row declarations no longer cite internal planning labels that no spec or doc page defines; the mechanism text and the `SPEC` and `§13.x` citations stay. No behavior changes.
