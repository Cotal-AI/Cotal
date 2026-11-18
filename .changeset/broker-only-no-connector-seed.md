---
"@cotal-ai/cli": patch
---

Start broker-only stacks without installing unrelated application connectors or requiring npm.

`up --no-manager` leaves connector seeding to commands that need it, including when refreshing a running stack or starting in the foreground. Manager-enabled startup still checks and reconciles connectors before launch.
