---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A manager that fails while it starts now names its next step. The last line its native child logs ended at the cause, because the child's startup wrappers carried no remedy, so `cotal manager start` and `cotal service logs manager` gave no next step. That line now ends `next: inspect the original full instance and its launch request before another start`, the step the service controller names for a native start it could not confirm. `service start --foreground` prints its lifetime notice on stderr, so a manager that fails in the foreground prints the `Mesh:` heading and that notice, then its failure line, then the refusal, all on one stream.
