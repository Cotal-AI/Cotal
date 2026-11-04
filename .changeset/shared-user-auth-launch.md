---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
---

Export one UserAuthLaunch type for the user-mode identity carried through launch options, material and manager provisioning/resume data. Check the material reader's reconstruction against the complete declared type without changing runtime validation or serialization.
