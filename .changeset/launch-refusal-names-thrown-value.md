---
"@cotal-ai/manager": patch
---

A spawn refused by a connector's `buildLaunch` or the runtime's spawn now reports what was thrown. A connector that threw `null` or `undefined` used to make the manager reply with its own `Cannot read properties of null (reading 'message')`, a thrown string ended as the generic `spawn failed after accept`, and an object whose `message` is a Symbol left the accepted goal with no terminal. The local user-mode auth preflight refused the same way when the auth provider or the secret store rejected with such a value. Each refusal now carries the thrown value as text, or `an unreadable rejection` when the value cannot be read.
