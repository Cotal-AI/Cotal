---
"@cotal-ai/cli": patch
---

Report the running controller broker in status JSON instead of a stopped legacy process.
The nats row keeps its legacy PID-file observation, adds the owned-service process observation,
and names which source supplies its summary state and PID.
