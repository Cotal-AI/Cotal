---
"@cotal-ai/manager": patch
---

Route the broker transport's own dials through the manager's dial again, so a test that replaces the manager's dial intercepts them as it did before the transport moved into its own component.
