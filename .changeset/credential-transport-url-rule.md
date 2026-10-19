---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

The rule for which URLs may carry a credential, `https:` or plain `http:` on a loopback IP literal, now has one definition: `isCredentialTransportUrl` in `@cotal-ai/core`, next to `isLoopbackLiteral`. The managed handoff's exchange URL, `agent-bearer --exchange-url`, enrollment redeem, the pinned exchange, the IdP URL, the JWKS pin, the space-catalog link, `cotal sync`'s account binding, the manifest's IdP check and the pinned-fetch check for registration all call it and keep their own error text. Before, each spelled the scheme check inline, so a copy that dropped the `http:` clause would have accepted `ftp:` or `ws:` on loopback. Which URLs pass and which are refused is unchanged.
