---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

Maintenance journals can now record controller custody: the cut's original members and their per-role stop receipts, preserved-exit stop attempts, the resume's started members, a private commit-token handoff record (path, inode and digest, never the token), and an alternate-target restore's broker reconfiguration. The readers are closed, so each new field must match the cut's custody. Listener proofs bind only in the variant that matches custody, and a controller proof also needs a live running check from the caller. Stack resume reports `process-exit` evidence when a member carries its own stop receipt. Older readers refuse journals that carry these fields.
