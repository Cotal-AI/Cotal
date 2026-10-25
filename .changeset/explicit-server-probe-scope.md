---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Correct the explicit `--server` refusal documentation: target resolution without `--space` can probe recorded brokers before the explicit address. The request is not retried at a recorded broker, but this is not a promise that no other broker is contacted. The paragraph also distinguishes refusal wording from the separate `status` infrastructure report and records the case where no registration was retained.
