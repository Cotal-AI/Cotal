---
"@cotal-ai/auth": patch
---

A user-mode `cotal chat` session connects again. Since endpoint caller grants were added, the callout looked up a chat session as an actor grant when resolving its endpoint caller rights, found none and denied the connect, so every user-mode chat session was admitted but failed with `Authorization Violation`. The callout now mints a chat principal no endpoint capability without that lookup, as the spec states, and the chat arm stays its connect authority.
