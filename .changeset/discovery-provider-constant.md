---
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

The auth provider name is one exported constant shared by the provider and the discovery bundle, and the seam between the served document and the consumer that registers from it is now tested live.

The auth-service's public face serves `/.well-known/cotal-mesh`, and that document is exactly what
`cotal meshes add --from <origin>` fetches and registers from. The document's shape was fixed
separately; what was still held only by agreement is the provider NAME. It appeared as a bare
`"cotal"` literal at three sites, two of which are the two ends of one contract: the name the
registered `AuthProvider` answers to, and the name the served document advertises. A document naming
a provider other than the one serving it parses cleanly — the consumer requires a provider name, not
any particular one — and registers an entry that resolves to nothing. Those sites now read a single
exported `AUTH_PROVIDER_NAME`.

The regression guard lives at the composition root (`bin/smoke/discovery-bundle-consumable`), which
is the only tier permitted to import both the auth daemon and the CLI's consumer — the seam the
original defect hid behind is precisely the boundary those two packages may not cross directly. It
starts a real auth-service against a real broker and IdP, fetches the document over the wire, and
hands the raw bytes to the shipped `checkUserBundle`. Nothing in it constructs the shape it hopes to
see. That crossing is the part that had never existed: both sides had passed review because each
side's own tests build the shape that side expects, so the producer's smoke asserted the fields it
had just written and the consumer's smoke fed itself a hand-written fixture.

The provider-name cell compares the served name against `cotalAuthProvider.name` — the registered
provider's own identity — rather than against a string the test also chose, so it grades the outcome
(the two names agree) instead of the mechanism (both sites read one constant). Grading the mechanism
would pass a tree where both sites moved together, which is the failure this is for.

Scope, stated exactly: this unifies the provider name and proves the served document parses. It does
not change the document's shape or its fields, and registration applies further gates after that
parse — `checkServer`, TLS intent, and the dial policy on the bundle's `server` — so a deployment
that cannot publish an honestly dialable broker coordinate is still not registrable, and nothing
here weakens those gates or invents a coordinate to satisfy them.
