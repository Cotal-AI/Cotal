---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

Attach on an open-mode mesh, which never has a local seed

`cotal attach` refused every seat on a mesh started with `cotal up --open`, saying it needed this
space's local seed to redeem the session grant. An open-mode mesh has no seed by design, so the
refusal fired on exactly the configuration attach exists to serve, and its remedy pointed at
re-registering a root the mesh had already resolved correctly.

How a session grant is redeemed is now the recorded mesh contract, carried as a value rather than
inferred from whether a credential happens to be present. An open mesh redeems over the same bare
connection the control round trip already used, and nothing is minted or synthesised for it. A
static-auth mesh still mints a session-scoped credential from the seed at the root the mesh
resolved to, and a static-auth mesh whose seed is missing still refuses, now naming
restore-at-checkout rather than a re-registration that would change nothing. A user-auth mesh still
refuses loud: two-step user-mode redemption is not wired.
