---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

A role is now refused unless it is one `[A-Za-z0-9_-]` token, both when an endpoint registers it and when a sender addresses it. Routing used to rewrite any other spelling into a subject token, so ` probe ` reached the `probe` queue and `pro.be` reached `pro_be` while the message kept the spelling sent, and an anycast to `*` was stored on a subject no role consumer matches. `CotalEndpoint` now throws on a `card.role` outside the grammar, `anycast` and `anycastAttributed` throw on such a role or `*` before publishing, and `taskDurable` refuses one instead of rewriting it. `assertValidRole` is exported and `routeToken` is no longer exported, since a role routes as spelled. `cotal_anycast` names the role it was given in its receipt and counts holders whose role matches it. See the 0.71.0 section of `docs/UPGRADING.md`.
