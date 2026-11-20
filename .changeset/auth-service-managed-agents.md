---
"@cotal-ai/auth": patch
---

Move the authority plane's managed-agent operations (retained-agent validation, managed-agent enrollment and its verification, prepare-retirement and the runtime check) out of `service.ts` into an internal `service-managed-agents.ts`. The package surface is unchanged.
