---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Validate the landing `--channel` (or join-link channel) grammar before dialing in `cotal join`, rejecting invalid names such as empty segments with `USAGE_INVALID` instead of reporting missing mesh provisioning.
