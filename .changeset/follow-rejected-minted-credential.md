---
"@cotal-ai/cli": patch
---

When the broker rejects the credential a `cotal history --follow` or `cotal console` minted from the space's trust, as after `reset space`, the refusal it ends with now says to run the command again, which connects with the space's current trust. Before, it said to check your creds, which named a credential you never gave.
