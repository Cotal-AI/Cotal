---
"@cotal-ai/runtime": patch
"@cotal-ai/lang": patch
"cotal-ai": patch
---

Stop a parked step from dying on one slow pause-plane reply. A workflow `ask` that waited long enough settled `failed` with `{code: "L4000", kind: "handler-fault", message: "timeout"}` while most of its deadline was still unspent, the seat was alive, and nothing in the program threw. Measured on the reporting run: the two asks under 4.5 minutes settled `ok` and the two over 7.5 minutes failed with that exact record, with 11 minutes of deadline left.

The cause is how long a parked step reads for. While a pause is parked the run host polls the plane for the life of the step, once for the settle fact and once for the broker's fire, each read riding a NATS API request with its own 5s client-side deadline. A reply that arrives after that deadline raises the client's bare `TimeoutError: timeout`, and the interpreter records any non-`EffectError` throw as `L4000 handler-fault` verbatim. So the step issued roughly one unretried request per second for its whole duration and one late reply ended it, which is why the exposure grew with how long the step waited rather than with anything about the program.

A late reply is a fact about that one request and not about the pause behind it. The pause is a durable record on the plane, its timer is armed, and it is still answerable, so the read is now re-issued rather than raised, and the step settles on the answer it was waiting for. Re-reading is safe for the same reason the starvation repair's re-entry is: the plane's operations are idempotent by construction, and reading a one-use settle fact again observes the same world.

It is the second half of a distinction the host already drew for #1508 and it reuses that machinery rather than adding its own. A client deadline has two causes that produce the identical error, and the host can tell them apart by measuring whether its own event loop ran: off the CPU is the host's own starvation (`L4025`), and on it is a plane that answered late. The case that moves is only the second, which the classifier previously answered "fault" and handed to the program as its own failure.

Neither retry is unbounded and neither is merged into the other. A run that cannot be served must fail rather than hang, so the two conditions carry separate counts that are never reset, which bounds the call however they interleave; a host that stays starved still fails under `L4025`, and a plane that never answers now fails under the new `L4026` naming the measurement rather than the effect. The two are kept apart because the remedies differ: one says give this host capacity, the other says the broker is behind. Every failure that is not a client deadline is still raised on the first attempt, unretried and unwrapped, and still recorded as `L4000`.
