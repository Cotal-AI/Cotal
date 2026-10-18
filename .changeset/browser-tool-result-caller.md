---
"@cotal-ai/core": patch
---

`@cotal-ai/core/browser` reads private tool results from a strict-CSP page. `openBrowserToolResultCaller` calls `tool-result`, `tool-result-consent` and `tool-result-revoke` in `handle` mode on one agent incarnation, over the holder's own `tool-result-caller` bearer and the host-supplied responder epoch, with every pin checked before the connection opens. The entry packages the `tool-results` cluster generated from the canonical contracts (`gen-browser-contracts.ts extract ... tool-results`); no Manager surface includes it, and the Manager caller's behaviour is unchanged.
