---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

A manager lease renew that gets no answer no longer terminates the manager; the key is re-read
first.

`renewLease` treated every throw from the CAS renew as the lease being lost and fail-closed the
whole instance: it cleared the renew timer, tore down every agent it managed, and exited. One of the
things that throws there is a request that gets no answer within its deadline, and no answer proves
nothing about the key. It does not prove the write failed, it does not prove the key expired, and it
does not prove anyone else took it. The write may even have landed with only the acknowledgement
lost, in which case the manager killed itself over a lease it had just successfully renewed, and
took its agents with it.

A failed renew is now a question rather than a verdict. The manager re-reads its own key, which
separates "it is gone" from "I could not find out", and fails closed only on proof: the key is
absent, or it is present and holds a different process. When the key is still its own the manager
adopts whatever revision the broker actually has and keeps serving, saying so. When no answer is
available at all the bound is time rather than attempts, because past one whole TTL without a
confirmation the key may have expired and been re-acquired, so the instance can no longer claim to
hold it and stops on that ground, in those words.

Waiting is only safe if there is room to wait, so the renew budget gained slack. The TTL is
unchanged and no stored config moves, but the holder now renews at a quarter of it rather than a
half, and each attempt carries a deadline shorter than the period instead of the JetStream default,
which was itself half the TTL. Under the old numbers exactly one attempt fitted inside the window
and its own deadline consumed the remainder, so a single slow round trip was terminal by
construction.

Renews also no longer overlap. A renew whose reply is late runs past the next tick, since the
re-read that follows it has a deadline of its own, and a second renew started there read the same
cached revision and was refused over a sequence the first one had legitimately moved. That conflict
was self-inflicted, and it reproduced on every attempt before the guard.

Measured against a real manager process, with a relay between it and the broker holding back one
direction for exactly one renew deadline: the request reaches the broker and takes effect, only the
acknowledgement is delayed. On the old code the manager exited while its key was present, still its
own, and carrying a revision newer than the one it was holding.
