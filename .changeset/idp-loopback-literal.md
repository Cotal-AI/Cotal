---
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

The IdP URL, the pinned JWKS URL, the space-catalog link and `cotal sync`'s account binding now share one plain-http rule: `https://`, or `http://` on a loopback IP literal, decided by core's `isLoopbackLiteral`. Before, each spelled its own host list, so `cotal login --idp http://127.0.0.2/api/auth` and `http://[::ffff:127.0.0.1]/api/auth` were refused, `http://localhost/api/auth` signed in but dropped its same-origin catalog link, and the JWKS pin accepted any scheme on `127.0.0.1` or `localhost`, such as `ftp:` or `ws:`. Every loopback literal now passes and `localhost` is refused everywhere, because a hosts entry would choose the IdP and the keys the callout trusts. A mesh with an IdP pinned on `localhost` must move its pin to `127.0.0.1`; see the upgrading guide.
