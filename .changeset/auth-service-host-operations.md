---
"@cotal-ai/auth": patch
---

Add the dormant service host operations behind the service custody writer: register admission, approve, refuse, revoke and the operation and proposal reads, over closed per-key records in the auth store. Nothing in the product constructs them yet and the index does not export them. The service host contract gains the typed results and closed parsers these operations return. Once an operation is bound, `pending`, `held` and `refused` results name it, revoke results report whether deny-new landed, and completed results say whether they were applied now or returned from the record. Proposal and operation reads gain separate terminal views that carry no commands or cluster digests.
