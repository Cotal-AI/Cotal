---
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
---

`cotal attach` now opens a seat's session on a user-auth mesh. The CLI presents its bearer identity together with the session grant to the auth service's exchange, which issues a `session-caller` view bearer only after it confirms, against the redeemed `session.<id>` row and the serving manager gate, that this owner and actor hold that session. The callout re-checks the same row and mints the same `session-caller` rails with the grant's expiry that the static path mints. No local seed is read or written.
