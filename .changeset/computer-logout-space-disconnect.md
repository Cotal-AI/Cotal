---
"cotal-ai": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Signing out on a computer now names any running agents in that account's spaces and asks first (or accepts `--stop-agents`), disconnects this computer from each of the account's spaces before revoking the provider session and clearing the local login, stops before revoking if a disconnect cannot finish, keeps enabled spaces enabled on the account-computer binding so they reconnect automatically on next sign-in, and presents the signed-out state in Desktop and CLI (`cotal logout --local` revokes and clears only the local CLI login without touching the background service).
