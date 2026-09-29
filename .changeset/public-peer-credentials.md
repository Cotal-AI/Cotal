---
"cotal-ai": patch
"@cotal-ai/seat": patch
---

Export the existing Linux socket peer-credentials reader and its type from the seat package root so embedders can apply their own UID policy without importing private native-helper paths. Verify the public API with real separate-process Unix sockets and explicit unsupported-platform refusal.
