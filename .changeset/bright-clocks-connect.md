---
"@cotal-ai/core": patch
"cotal-ai": patch
---

Daemon service connections now identify credentials that are not yet valid by the machine's clock.
The refusal tells you to check the machine's and space authority's clocks instead of reporting an
unreachable space. Bearer verification still fails closed and retries preserve the saved request IDs.
