---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
---

The loopback check that lets plain http carry a credential now has one definition, `isLoopbackLiteral` in `@cotal-ai/core`. `agent-bearer --exchange-url`, the pinned exchange, enrollment redeem, the managed handoff reader and workspace `isLoopbackHost` all call it, so a fix to the rule can no longer reach only some of them. It parses the address, so every IPv6 spelling of `::1` is loopback and a dotted host that is not an IPv4 literal, such as `127.0.0.09`, is not. `isLoopbackHost` keeps only the legacy IPv4 canonicalization a `nats://` host needs.
