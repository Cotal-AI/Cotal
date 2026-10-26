---
"@cotal-ai/auth": minor
"@cotal-ai/core": minor
---

The auth service now holds one issuer session for the issuance its callout makes on a user-auth connect, where it used to mint credentials and dial a new connection for every issued connect. That dial was most of an issued connect's cost: about 15 ms one at a time, and over 200 ms each when 16 arrived together. Each auth-service context and each `--callout-only` replica holds its own session. Its credential keeps the five-minute `issuer` expiry and is replaced before it expires. The connection never reconnects. It is closed and drained when the plane is fenced, when the service stops, or when the connection is lost, and the next issuance dials a new one. Each issuance still makes its own reads and writes, and a write in flight at a loss is never sent again. Retiring a lifecycle's issuances and every other issuance window still use a one-shot session. `@cotal-ai/core` exports `holdIssuerSession`, and `startAuthService` takes an optional `issuerSessionTtlSeconds` from 5 to 300 seconds.
