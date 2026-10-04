---
"@cotal-ai/web": patch
---

The web dashboard now binds the account seed only inside the step that connects and mints its channel-purger cred. Before, the full connection, seed included, stayed in scope of the request handlers beside the narrowed copy they were meant to use, so a one-word edit in a handler could reach the seed and still compile. A handler that reaches for the seed now fails to typecheck.
