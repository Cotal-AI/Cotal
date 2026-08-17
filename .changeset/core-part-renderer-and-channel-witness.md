---
"@cotal-ai/core": minor
---

Add the generic part-renderer seam, the principal-channel grant witness, and expecting publish.

`PartRenderer` lets a surface draw a part kind core does not know, resolved by the part's own `kind`
so core never learns what any of them mean. A kind with no renderer and a renderer that throws get
different markers: a reader who meets one must not conclude the other, and neither may blank the
message or take the surface down.

`principalChannelWitness` / `assertPrincipalChannelGrants` catch a grant that matches no
principal-keyed channel. Keying a channel on a principal costs one token more than the flat form it
replaces, so an operator holding an old single-token wildcard gets a grant matching nothing, which
at the broker is indistinguishable from a channel with no traffic. The launch reports success and
the stream is silently mute. The mismatch is now named at grant time, and a witness subject is
returned rather than a boolean so a refusal can show the operator a subject their grant would have
covered.

`multicastExpecting` / `encodedSize` publish under a subject expectation, with the envelope built in
one place so a frame and any measurement of that frame cannot describe different messages.

A name carrying an unpaired UTF-16 surrogate is refused: it cannot survive UTF-8 encoding, so
distinct names would otherwise collapse into one identity.

`assertExpectationSemantics` now states its scope correctly. The `num_replicas: 1` requirement is a
property of the one chat stream it reads, not of the broker, and the old message read as a global
rule. A clustered deployment runs fine so long as that stream is R1, which a cluster can host.
