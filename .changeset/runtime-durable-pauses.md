---
"@cotal-ai/runtime": minor
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
---

Add durable pauses to the workflow runtime: `sleep` and `checkpoint` now run on the real planes
rather than only in the simulator. Both are the same thing underneath — a checkpoint minted with a
deadline, an armed timer on the mediated plane, and one create-only settle fact that a resume and
the deadline race for — and the only difference is that nobody ever answers a sleep. There is no
second timer mechanism, which is one fewer thing to get wrong.

A pause survives a crash without anything being remembered across it. The identity a handler submits
under is written to the journal BEFORE the handler runs, and it is a valid checkpoint token by
construction, so a resumed run re-derives the same token and the mint's idempotency attaches it to
the timer the crashed attempt armed instead of arming a second under a deadline nobody chose.

Answers get their own record. The settle fact is the arbiter of a race and its keys are closed, so
the value and the artifact digest of what an answerer actually saw live in a `answer.<endpoint>.<token>.<answerId>`
record, and the fact carries the id it accepted. That last field is the point rather than a detail:
a workflow checkpoint's holder is the run driver and every resolver reaches it through the driver's
own `resolveCheckpoint`, so every presenter is the same principal and an answer cannot be matched
back to the settlement that took it by who presented it. Keyed per answer and named by the winner,
two resolvers racing end with the program reading the answer that won rather than the one written
last. Answers are written before the token is presented, so a refusal in between leaves an answer
nobody accepted rather than a run released with its answer nowhere.

Taking a run over now re-arms its pauses. An armed schedule fires onto a subject derived from the
instance and epoch that armed it, so a run adopted by another host has live timers firing where
nobody is listening — and resuming the program does not repair that, because the pause replays as
pending and goes straight back to waiting. The driver hands the resumed prefix to a hook after the
activation and before the program restarts; a failure there is a failure to take the run over.

In the language, a recorded step can be addressed by the key it was written under
(`journalEntryKeyString`), which is how anything outside the language names a step — the key grammar
stays in one place instead of being re-joined by hand at every caller.
