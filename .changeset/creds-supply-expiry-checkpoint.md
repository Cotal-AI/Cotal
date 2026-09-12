---
"@cotal-ai/core": patch
---

Refuse to present an expired credential to the broker on every path an endpoint can reach one from, not only its own dial. The expiry check now sits on the endpoint's credential supply itself, so the reconnects the NATS client performs on its own present a credential that has just been checked instead of whatever was last fetched. Two such reconnects exist and neither goes through the endpoint's connect path: the one the broker forces when a JWT reaches its expiry, and a dial loop still retrying after an earlier drop that crosses the expiry mid-retry. The pre-expiry reconnect fence cannot stop the second, because it sets a policy flag the client only re-reads when it observes a new drop.

An endpoint holding a static credential is now checked too, where before only a renewing one was. Explicitly reloading a credential checks the candidate locally before the preflight connection, so an already-expired re-signed generation is refused without a round trip and can never become the resident connection's credential.

The refusal fails closed, not dead: a renewable endpoint keeps retrying on capped backoff and re-fetches from its source on each attempt, so it recovers by itself once renewal starts working. Both messages name the remedy that applies -- wait out the retry when a source can renew, replace the credential when there is none. An endpoint whose very first fetch never returned now fails with that source's own error instead of dialing with no credential at all. A credential with no expiry claim is unaffected.
