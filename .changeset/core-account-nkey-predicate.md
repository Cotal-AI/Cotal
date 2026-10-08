---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/delivery": patch
---

`@cotal-ai/core` exports `isAccountNkey`, the shape rule for an account nkey public key, and every site in core, `@cotal-ai/auth` and `@cotal-ai/delivery` that checks an account public key calls it. The run admission and run attempt parsers now refuse an `accountPublicKey` that is not an account nkey as a bad request. They accepted any non-empty string before, which only the later comparison with the assigned account refused.
