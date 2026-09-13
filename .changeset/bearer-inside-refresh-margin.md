---
"@cotal-ai/core": patch
---

A bearer source that keeps returning a token already inside its refresh margin no longer drives the
endpoint into a 5-second read loop. The next refresh was armed from the token that had just been
fetched, and a token inside its own 60-second margin computes a non-positive delay, which the arming
floor turns into five seconds. The next read returned the same near-dead token and computed
non-positive again, so the endpoint hit the auth service every five seconds for the rest of that
token's life. The 15-second retry backoff never applied, because the fetch had not failed: it
succeeded and returned material that could not carry the next cycle. Such a fetch is now treated as a
failed renewal — one recoverable warning and the normal backoff — and the cached token is left in
place, so the live connection keeps working to its own expiry. The first fetch is unchanged: there is
no previous token to keep, and startup has to come up on whatever the source has.
