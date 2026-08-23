---
"@cotal-ai/cli": patch
---

Registration's exchange probe now pins the exchange's own issuer (`urn:cotal:auth:<space>`, derived from the bundle's `space`) instead of the IdP issuer. The auth daemon's `/health` reports its own token issuer, so pinning `userAuth.idp.issuer` made `cotal meshes add --from` refuse every bundle the daemon's public face generates. The user-bundle smoke pins the cli-side derivation against auth's `spaceIssuer` so the two cannot drift.
