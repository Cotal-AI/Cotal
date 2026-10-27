---
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

`cotal supervise` reports a broker's refusal of the manager's credential as a refusal, not a bare `✗ Authorization Violation` line. Started from a folder whose signer for the space the running broker does not trust, such as a second root that once hosted the same user-auth space, it exits 2 with code `PERMISSION_DENIED` under a `Mesh: <space>` heading. The message names the credential, the folder that minted it and the broker, and the native detail keeps the broker's own words. Next names the folder that hosts the space, and on a user-auth space the signed-in participant path for a manager on another machine. The user-auth launch suite covers it with a second root.
