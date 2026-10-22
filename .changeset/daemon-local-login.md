---
"cotal-ai": patch
---

Add `cotal daemon login` on Linux. The running daemon signs in with device approval through the same flow as `cotal login` and keeps the session in the machine's Cotal home. The command shows only the approval link, code and expiry, then the signed-in account. No session token crosses the local endpoint. One sign-in runs at a time. Ctrl-C or a dropped connection cancels it and saves nothing, even after approval, and revokes nothing at the provider. `status` keeps answering during a sign-in. Each connection may send at most 64 requests.
