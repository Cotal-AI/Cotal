---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Clarify the explicit `--server` refusal documentation: the request is not retried at a recorded broker, and target resolution probes only records at the explicit address. The paragraph distinguishes refusal wording from the separate `status` infrastructure report, records the case where no registration was retained, and names the broader checks explicitly requested by `status --all`.
