---
"@cotal-ai/core": minor
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Apply a signed-in account's space catalog to the registry under the provider's catalog lock, and
record in the cache whether the snapshot was applied in full. A command that dies or is stopped
while applying no longer leaves a partial registry that fresh and not-modified refreshes accept:
the next command applies the cached snapshot again first. `prepareSpaceCatalogs` and
`syncSpaceCatalogAfterLogin` now take the consumer's `apply`.
