---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Keep endpoints without an error listener alive when their broker credential expires, and give each provisioning operation in the send smoke test a fresh credential.
