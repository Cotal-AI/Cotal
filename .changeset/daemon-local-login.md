---
"cotal-ai": patch
---

Add `cotal daemon login` on Linux. The running daemon signs in with device approval through the same flow as `cotal login` and keeps the session in the machine's Cotal home. The command shows only the approval link, code and expiry, then the signed-in account. No session token crosses the local endpoint. One sign-in runs at a time. Ctrl-C or a dropped connection cancels it and saves nothing, even after approval, and revokes nothing at the provider. A failed sign-in is reported with a fixed sentence per reason and never relays the provider's error text. A denial, an expired code or an unreachable provider saves nothing. Any other failure may come after the session was saved, and the command says so. `status` keeps answering during a sign-in. Each connection may send at most 64 requests.
