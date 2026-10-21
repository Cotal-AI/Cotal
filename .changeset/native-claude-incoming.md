---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
---

Deliver incoming local-mesh messages through Claude Code's native plugin hooks, including supported Desktop Code sessions, without special launch flags. Surface busy notifications at a main-conversation boundary instead of waiting for the whole turn. Preserve plugin attribution, respect native Stop, and reoffer unread wakes when the local reader restarts. Idle wake notifications display as a compact, expandable Cotal indicator. Setup can use Desktop's bundled Code executable and records Node's absolute path so the app needs neither a separate terminal CLI nor Node on its PATH.

Refresh existing Claude messaging and skills plugin registrations during updates and ordinary first use after an npm upgrade. Preserve disabled settings and check the resolved payload rather than only the marketplace copy. A missing native runtime refuses the upgrade without accepting a stale generation. Allow an update after configure-only setup when the local project has no manager or broker running.
