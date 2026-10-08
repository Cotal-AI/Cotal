---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
"@cotal-ai/linear": patch
---

Core exports `serviceContractTable(rows)`, which builds a service's command contracts, compiled on first access, and the schema artifacts its registration publishes. The auth, manager and Linear service contracts call it instead of carrying their own copies of the lazy table and the artifact loop, so a fix to either reaches all three. Importing a contract module still compiles nothing, and the published artifacts and the behaviour of `AUTH_CONTRACTS`, `MANAGER_CONTRACTS` and `MANAGER_STATUS_CONTRACT` are unchanged.
