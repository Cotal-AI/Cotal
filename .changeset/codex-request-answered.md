---
"@cotal-ai/connector-codex": patch
---

A Codex seat returns to `working` once the host has declined an app-server request, so a turn that ends after one still fires the done boundary and does not leave an approval condition on an idle seat.
