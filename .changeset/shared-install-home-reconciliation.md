---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Shared CLI installations now distinguish home-local connector reconciliation from updating the CLI itself.
Keep ordinary per-home reconciliation, name `cotal update` for stale local inventories, and refuse automatic generation migration while a recorded local Manager still runs another version.
