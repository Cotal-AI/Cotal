---
"@cotal-ai/cli": patch
---

`cotal up` now resolves, writes and reclaims the user-auth service's pid record with the workspace rules `cotal down` and `cotal status` use, and the CLI's private copy of those rules is removed. When both the canonical and the pre-hex record exist, `up` and `down auth` now refuse with the same message, and a pre-hex record that cannot be reclaimed is refused in the shared wording. An error listing `.cotal` other than a missing directory now stops the auth step instead of reading as no record.
