---
"@cotal-ai/auth": minor
"@cotal-ai/connector-core": patch
---

The generated mesh discovery document now carries the canonical `userAuth` wrapper, so it parses in the consumer `cotal meshes add --from` validates it with.

The auth-service's public face serves `/.well-known/cotal-mesh`, and that document is exactly what
`cotal meshes add --from <origin>` fetches and registers from. It was emitted flat — `idp` and
`endpoints` at the top level, with no `userAuth` and no `provider` — while the consumer requires the
`userAuth` wrapper that the rest of the tree speaks (the mesh registry, connect, launch material).
Feeding the real served bytes to the real consumer was refused with "auth provider publicAuth: a
provider name is required", so registering a remote mesh from its own discovery URL could not work.

Both sides had passed review because each side's tests built the shape that side expected: the
producer's smoke asserted the flat fields it had just written, and the consumer's smoke fed itself a
hand-written `userAuth` fixture. Nothing had ever handed the server's actual response to the
consumer, so the seam between them was untested in both directions at once.

The bundle now emits `userAuth { provider, idp { url, issuer, audience }, endpoints { url } }`,
written from the same values as the existing top-level keys, which are retained rather than
replaced: they shipped, and removing a shipped field would break any reader already parsing them.
The provider name is now a single exported constant shared by the provider and the bundle, because a
document naming a different provider than the one serving it would register an entry nothing can
resolve.

The regression guard lives at the composition root (`bin/smoke/discovery-bundle-consumable`), which
is the only tier permitted to import both the auth daemon and the CLI's consumer — the seam the
defect hid behind is precisely the boundary those two packages may not cross directly. It starts a
real auth-service against a real broker and IdP, fetches the document over the wire, and hands the
raw bytes to the shipped consumer.

Scope, stated exactly: this fixes the document's SHAPE and proves it parses. Registration applies
further gates after that parse — `checkServer`, TLS intent, and the dial policy on the bundle's
`server` — so a deployment that cannot publish an honestly dialable broker coordinate is still not
registrable, and nothing here weakens those gates or invents a coordinate to satisfy them. That is a
separate question about what a deployment can honestly advertise, deliberately left open.
