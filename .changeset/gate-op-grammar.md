---
"@cotal-ai/core": patch
---

`parseIssuanceGate` and `parseEndpointGate` now validate a gate's op intent through one shared grammar. Each parser used to carry its own copy of the SPEC 13.1 op rules, and the endpoint copy wrote the op kinds and gate states as inline lists, so a change to the kind set reached only the agent gate and the two families could disagree with nothing failing. Both parsers accept and refuse the same rows as before. The endpoint gate's refusals for a frozen or retired gate without its op, and for an open gate with one, now carry the same explanation as the agent gate's.
