---
"@cotal-ai/cli": patch
---

When a prepared Linux space cannot start because its machine ID is missing, Cotal names the required file and explains how to provision it without systemd. A missing boot ID is reported separately, and both checks still refuse before starting any service.
