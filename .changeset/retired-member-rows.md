---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Retire a lifecycle's durable membership rows through target-pinned exact-key grants. Complete inventory derives channels from validated native keys, including wildcard-covered and unnamed channels, so unreadable values cannot hide rows from cleanup. An unavailable inventory retains undiscovered rows and holds retirement pending retry. Other principals and successor lifecycles remain untouched. Retirement fixtures now use complete zero-row responses only for empty synthetic inventories, and the user-mode test verifies held retirement until genuine delivery returns.
