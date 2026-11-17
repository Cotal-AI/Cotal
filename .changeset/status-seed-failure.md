---
"@cotal-ai/cli": patch
---

Status now reports recorded connector setup failures and the repair step before startup guidance.
It preserves the package, phase and cause in JSON, reports interrupted seed and repair records too, exits 5 for the incomplete setup, and leaves those records unchanged. Live reconciles and installers are reported as work in progress without a repair instruction. Other diagnostic remedies, including command-shaped recovery routes exposed as `nextCommands` in JSON, remain available after the seed recovery steps.
