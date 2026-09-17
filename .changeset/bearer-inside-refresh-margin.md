---
"@cotal-ai/core": patch
---

A bearer refresh now refuses two kinds of answer from the source, and it no longer refuses a third
that was never wrong.

Refused: a token that has already expired. It is unusable whatever else is true of it, and an
advancement comparison lets one through, because a candidate dying at `now - 5s` does advance a held
token that died at `now - 60s`. Adopting it overwrote the cached token with material nothing can
dial, emitted no recoverable warning (the fetch had not failed), and armed the next read off a
non-positive delay. The credentials path draws the same line on expiry alone.

Refused: the byte-identical token the endpoint already holds, when that token can no longer carry
another cycle. This is the #1561 loop. The next refresh is armed from the token just fetched, and a
token inside its own 60-second margin computes a non-positive delay, which the arming floor turns
into five seconds. The next read returned the same near-dead token and computed non-positive again,
so the endpoint hit the auth service every five seconds for the rest of that token's life. The
15-second retry backoff never applied, because the fetch had not failed: it succeeded and returned
nothing new. Such a fetch is now treated as a failed renewal: the cached token is left in place, a
recoverable warning is emitted, and the next read waits for the 15-second retry backoff. A source
that keeps answering this way produces a warning on every retry, and once the held token expires the
expiry refusal takes over at the same cadence.

No longer refused: a token that was genuinely re-issued but carries the same `exp`. Expiry claims
have one second of resolution, so a key rotation that re-signs the same claims under a new key, and
a short-lived source read twice inside one wall-clock second, both produce one. An earlier rule
compared expiry and called these stale, which backed off fifteen seconds against material the broker
had just started requiring.

The five-second arming floor is unchanged and deliberately so: a deployment whose whole token
lifetime sits inside the refresh margin is legitimate, and for it that floor is the renewal cadence.

The first fetch is unchanged as well: there is no cached token to protect, and startup has to come up
on whatever the source has. The pre-dial guard continues to refuse to present a dead one.
