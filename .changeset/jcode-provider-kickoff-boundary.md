---
"cotal-ai": patch
"@cotal-ai/connector-jcode": patch
---

Wait for the observed post-join kickoff turn boundary in the provider-disconnect smoke fixture. Presence alone can precede that boundary, routing the test marker through a soft interrupt instead of the intended ordinary-turn disconnect trigger. Add a delayed-turn mutation and restored native checks. Connector behavior is unchanged.
