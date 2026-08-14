---
"@cotal-ai/core": minor
---

`partsToText` no longer renders an unrecognised part as nothing.

It returned `JSON.stringify(p.data)` for every kind it did not handle. `JSON.stringify(undefined)`
returns the value `undefined` and `Array.join` coerces that to the empty string, so an unknown
extension part rendered as nothing at all — the same vanishing act the `artifact` kind was fixed
for, still live for the next kind anyone adds. A `data` part carrying no `data` hit it too.

An unknown kind now renders a marker naming the kind, and an empty `data` part renders its own
distinct marker. Extension kinds stay opaque, which is deliberate and unchanged: core does not know
how to render one and must not pretend to. What changes is that not knowing now says so.

A marker rather than a throw, on purpose: a throw is swallowable, and a caller that catches it and
skips the message reinstates the silence one layer further up where it is harder to see.

This changes the rendered text a consumer sees for those two cases, so it is a behaviour change
rather than a pure fix.
