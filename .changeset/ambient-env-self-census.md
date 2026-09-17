---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/pi": patch
---

Census the in-process half of the ambient-environment rule. `smoke:suite-ambient-env` grades the environment a suite hands a child; the new `smoke:suite-ambient-env-self` grades a suite that reads its own `process.env` through `configFromEnv` and friends, and requires a module-scope `COTAL_` prefix scrub before that first read. The connector suites in the class now scrub the whole prefix instead of dropping one variable, so running them from inside a connected session no longer dies in its own import on the one-identity-plane refusal.
