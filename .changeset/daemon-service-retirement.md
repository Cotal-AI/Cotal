---
"cotal-ai": minor
"@cotal-ai/auth": patch
---

Disconnecting or uninstalling the daemon now removes its local service credentials and identity records.

Disconnect removes the selected connection's resume intent, private service store, registration request and identity after closing the responder and renewal source. Uninstall removes those records for every space under lifetime exclusion. Removal failures exit non-zero and keep the installation receipt for retry. These commands do not revoke remote authority, and their output names dashboard removal for that action.

Sign-out output now explains that an already connected daemon continues on its own service proof and names local disconnect and dashboard removal as the ways to end it. Reconnecting after explicit disconnect requires a new registration and approval.
