---
---

Test-only: moves the shared smoke broker teardown helper into a new private `@cotal-ai/smoke-kit`
package so suites outside `packages/core` can own their brokers without a hand copy, and enforces
its rails in the boundary smoke. No shipped behaviour changes, so no release.
