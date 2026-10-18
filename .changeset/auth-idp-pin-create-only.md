---
"@cotal-ai/auth": patch
---

The first IdP pin is now written by exclusive create. Two processes enabling user auth on one state dir at once used to both succeed, each holding its own IdP while `idp.json` named only the last writer. Now one pin wins: the other caller adopts it when it names the same IdP and is refused with the usual re-key message when it does not.
