---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

`cotal manager start` and `restart` on a user-auth space now confirm the cached sign-in with its IdP before they save or launch anything. A sign-in the IdP rejects because it expired or was revoked is refused `AUTH_REQUIRED` (exit 2) with `cotal login --idp <base>` as the next step, as no sign-in is. Before, a participant's start launched the manager, which failed `OPERATION_FAILED`, and a hosting folder's start left the manager running behind an `OPERATION_UNKNOWN`. A space registered from another host now gets the signed-out refusal too. Any other failure of the check, such as an IdP that does not answer, is left to the start as before.

Breaking for custom auth providers: `AuthProvider` gains `confirmLogin`, which the stock provider implements with one IdP proof and no mint. `manager start` and `restart` on a user-auth space refuse `UNSUPPORTED` when the installed provider does not implement it.
