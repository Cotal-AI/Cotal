---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Component status now keeps the auth-service recovery hint when an exchanged bearer has an unreadable principal. It uses the workspace principal decoder instead of a separate copy, preserving the caller's owner, actor and lifecycle binding. The decoder is available from the workspace package for client-side inspection, not signature verification or authorization.
