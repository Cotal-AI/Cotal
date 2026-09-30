---
"@cotal-ai/auth": patch
---

Start the bootstrap membership renewal fixture with a genuinely expired credential and verify broker refusal before renewal. This avoids depending on different JWT bytes when two fresh issuances occur in the same wall-clock second. Keep the native renewed-credential, stable-identity and broker-acceptance checks, with explicit mutation controls.
