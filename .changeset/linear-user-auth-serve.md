---
"@cotal-ai/linear": minor
---

`cotal linear serve` now serves on a per-user-auth mesh through the space's remote service authority instead of refusing:

- The first start submits a registration proposal and exits. The proposal carries the Linear cluster closure and its commands' schema closures. A start after the owner approves replays it.
- `serve` then activates, derives the serve grant from the authority's registration snapshot, connects through the space's callout with the access bearer and sentinel creds, reports ready, and renews at half the bearer's life with one replayed renew request.
- Request identities persist in `linear/serve/<space>--<endpoint>.json` (0600, no secret). An unconfirmed outcome replays the same request.
- A denial, an expired renewal proof or a connection closed for good stops serving as an owner stop does, within the grace, and nothing is sent or reported after a stop. A start that stops before it serves fails instead of returning serving.
- Stopping keeps the instance registered.

The space's auth service must run with service endpoints enabled, and the endpoint name must be bound and the instance approved by its owner. Agents on a per-user-auth mesh cannot invoke the endpoint yet, because that mesh issues no endpoint caller rows.

The package exports `startLinearUserAuthEndpoint`, `linearUserAuthServeGrant`, `linearUserAuthRegistration` and `parseLinearUserAuthKeys`. The static path, `caller` and the `linear` service preset are unchanged.
