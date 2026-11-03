---
"@cotal-ai/auth": patch
---

Retiring a chat session or preparing a managed agent's retirement now removes every durable membership row of that lifecycle. Previously only rows on concrete channel names in the grant were removed. A row on a channel family (`review.>`), or on a channel that only a wildcard grants, stayed until a later post reached the delivery reader. The auth service now does what the manager's teardown does: it narrows the lifecycle's read-ACL row to no reads, reads the delivery daemon's `lifecycleMemberships` inventory, and deletes those rows along with the granted ones. If the inventory cannot be read, the named rows are still removed and the step fails, so its retry removes the rest. A chat session's retirement still completes and leaves the remainder to compaction. A managed agent's prepare-retirement keeps its grant until a retry succeeds.
