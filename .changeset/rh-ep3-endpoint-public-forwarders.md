---
"@cotal-ai/core": patch
---

Internal refactor: the bodies of the endpoint's `start`, `reconnect`, `requestDeliveryAdmin`, `dmHistoryOf` and `servePrincipal` move to the parts that own their state, and each public method stays on `CotalEndpoint` with the same signature and documentation. No behaviour change.
