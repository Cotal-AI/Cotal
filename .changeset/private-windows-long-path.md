---
"@cotal-ai/core": patch
---

Keep private secret writes working under long Windows paths when the system long-path policy is disabled. ACL hardening now passes an absolute extended-length path to icacls while preserving its permissions and fail-closed errors.
