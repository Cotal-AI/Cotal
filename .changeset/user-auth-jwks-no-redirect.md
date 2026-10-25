---
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

The JWKS check of a first `cotal up --user-auth` enable now refuses a redirect. A `3xx` answer at
`<idp>/jwks` is refused as an unavailable JWKS, and the place it points to gets no request. Before,
the check followed redirects, to another origin too, so it could pass on keys from a host that the
space's IdP pin does not name.
