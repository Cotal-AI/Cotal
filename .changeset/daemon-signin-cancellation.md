---
"cotal-ai": patch
---

Cancelling daemon sign-in no longer prints command help, and SIGTERM cancels it cleanly.
Both setup sign-in paths use the same cancellation handling as daemon login, including structured output.
