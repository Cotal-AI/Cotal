---
"@cotal-ai/manager": patch
---

`cotal supervise` now prints its refusal and exits 1 when the auth provider's manager-service authority call rejects with `null` or `undefined`. Its refusals read `.message` off the caught value, so that rejection ended the command on `Cannot read properties of null (reading 'message')` without the "remote supervision for space ... was refused" line, and a rejected string printed `undefined` as the reason. Every refusal the command prints now takes its text from the caught value's `message`, or the value itself when it has none, and a value it cannot read reports as `an unreadable rejection`, as the manager's other handlers do.
