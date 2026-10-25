---
"@cotal-ai/cli": patch
---

Refuse a broker store root without read access before startup, even when its JetStream folder is writable. Previously a write/search-only store root made `up` end `OPERATION_UNKNOWN` without naming the cause, and `status` suggested starting it again. Both now name the root and the quoted `chmod -R u+rwX` step. This does not require read access on the writable JetStream child, which can still retain messages without it, and no permissions are changed automatically.
