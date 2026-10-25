---
"@cotal-ai/cli": patch
---

Remove the unused detached broker boot-log callback and polling helper. Broker output remains in `.cotal/nats.log`, including startup failure diagnostics.
