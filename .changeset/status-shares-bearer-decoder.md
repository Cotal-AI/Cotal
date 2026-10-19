---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal status --components` on a user-auth mesh now reads the signed-in bearer with the same decoder as every other user-mode command. It kept its own copy, which printed an unreadable payload as a bare JSON parse error on the manager and delivery rows and never named the stale auth service. Those rows now carry the same sentence `cotal channels list` prints: `could not read the principal from the minted bearer (...) - the auth service's build may be stale; restart it with \`cotal up\``. `@cotal-ai/workspace` exports `principalFromBearer` for this.
