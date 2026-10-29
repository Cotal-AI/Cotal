---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Keep a broker that an earlier release started stoppable after an upgrade. Each instance record pins its adapter's declaration, and every control path compared that digest exactly, so a release that changed the built-in broker's declaration, even one option description as 0.121.1 did, left brokers started by 0.121.0 or 0.120.2 refusing `cotal service stop`, `cotal service logs` and `cotal down` (CONFLICT, "the selected broker pins another definition, adapter revision or stop policy") while they kept running. `cotal up` then refused to start such a stack again. A built-in or `@cotal-ai/*` adapter's instance now stays controllable while it names the same provider and runs under the stop policy that adapter declares now. A third-party adapter's instances still need their recorded version and declaration.
