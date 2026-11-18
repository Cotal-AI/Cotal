---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Explain how to stop hosted workflows on a default local stack.

The workflow guide and issue-orchestrator example now name `cotal down --yes` for a manager started without a saved service and state its whole-stack impact. A retained manager addressed as `stack-manager` refuses stop and restart with the supported stop path instead of suggesting a service definition. Prepared controller stacks keep their manager stop followed by `cotal up` path.
