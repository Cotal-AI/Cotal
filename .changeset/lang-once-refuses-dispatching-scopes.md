---
"@cotal-ai/lang": patch
---

A scope reached inside `once` is now refused with L4028 by its `dispatches` scope trait, the same row that gives it a request id and the effect ceiling. Before, the refusal named `conclave` by its literal kind, so a new scope kind that calls the handler would have compiled, run inside `once` with no refusal, and could have been dispatched again on resume. Shipped behaviour is unchanged: `conclave` is still the one scope that dispatches.
