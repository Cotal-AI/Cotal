---
"@cotal-ai/connector-core": minor
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Add the `artifact` message part: a reference to bytes too large to send.

Every Cotal message rides one NATS message under the broker's maximum payload, so moving a file
between agents has meant pasting bytes into chat until it breaks, or sharing a filesystem path that
stops working the moment two agents are not on the same machine. SPEC §5 reserved the answer; this
defines it. A message can now carry `{ kind: "artifact", name, mediaType, digest, size }` — the
content address of the bytes, and nothing about where they live, so the store behind it can change
without any message changing shape. This is the contract only: the transport that serves the bytes
lands separately.

The digest is the one field that is not taken on trust. `name`, `mediaType`, and `size` are
whatever the sender wrote, and a receiver that sizes a buffer from `size` or dispatches on
`mediaType` has believed a stranger; `verifyRawBytes` checks fetched bytes against the digest before
they reach a caller, which is what catches a store handing back a truncated object — otherwise
indistinguishable from a small one.

`artifact` is a bare core kind rather than a namespaced extension, because reverse-DNS kinds are for
wrapping vocabularies Cotal does not own, and this is Cotal's own reserved primitive. That
distinction has teeth: a core kind the message validator does not know is not a schema detail. The
validator gates the durable delivery frame, so an unrecognized core part means the backstop drops
the whole message, silently, and the loss shows up nowhere near the part that caused it. The
`artifact` guard is enforced there, and it checks the digest's form rather than only its type — a
malformed digest is not a reference to anything, and admitting one would turn a bad message into a
"missing artifact" that blames the store.

Message rendering moves to a single `partsToText` in core. The same one-line expression had been
copied into the connector inbox, `cotal join`, and the mesh view, and each copy fell back to
stringifying a part's `data` field — which an artifact part does not have, so all three would have
rendered it as the literal word "undefined". One renderer means a new core part kind is legible
everywhere at once, or nowhere, never in two surfaces out of three.
