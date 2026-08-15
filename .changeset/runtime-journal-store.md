---
"@cotal-ai/runtime": minor
"@cotal-ai/core": minor
---

Add `@cotal-ai/runtime`, the package that hosts a cotal-lang run on the mesh, starting with the
step journal's durable half: a `JournalStore` over the run journal's activation barrier. A barrier
failure — superseded by another driver, or an append that ended without a PubAck — reaches the
interpreter as the journal's own durability failure (L5010) rather than as an effect result, so a
run never records that work failed when the work was done and only the log refused.

In core, the run journal appender now stops on ANY append that ends without a PubAck, not only on a
refusal; a replay refuses a prefix that did not begin at the run's genesis, or that inherited a
consumer another driver had already read from; and a takeover under a lease fencing token older
than the one the run is held under is refused.
