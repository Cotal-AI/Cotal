---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

Route user-auth manager calls through a short-lived, instance-bound control credential. Discovery and invocation address the same authorized manager while the agent's standing connection, credentials and conversation remain unchanged. Managed launches retain their manager selection across launch and resume. Static and open mesh routing is unchanged. Confirm the standing goal-progress subscription at the broker before submitting on the separate control connection, so fast terminal events cannot outrun the subscription.
