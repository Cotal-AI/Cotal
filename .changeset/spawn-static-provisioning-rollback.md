---
"@cotal-ai/cli": patch
---

A foreground `cotal spawn` on a static-auth mesh now retires the agent's broker footprint when it fails after provisioning. A failed provisioner stop, secret write or creds file write used to exit with the agent's DM and DLV durables and its read-ACL row left on the broker, with nothing left to remove them. The spawn now records the agent's identity and creds path before it provisions, and the same retirement that follows a failed launch runs before the error is reported.
