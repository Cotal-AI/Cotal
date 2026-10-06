---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

The scope kinds' traits now come from one record keyed by `ScopeKind`, exported as `scopeTraits`: whether a scope settles an assembly of branch outcomes, and whether a fork whose cut lies inside it re-enters it. The journal seed check, the scope value rule, the static captured-write check (L2032) and `planFork` read it instead of keeping their own kind lists, so a scope kind added to `ScopeKind` does not compile until it is classified. Before, a new kind compiled with a list missed and failed only at run time, for example a settled no-return scope of that kind refused at the journal seed with L5024. Shipped behaviour is unchanged.
