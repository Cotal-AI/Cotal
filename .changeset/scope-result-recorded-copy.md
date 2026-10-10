---
"@cotal-ai/lang": patch
---

A concurrency scope now hands the program the deep-frozen copy of its result that its record carries, live as on resume, and no longer freezes the value the program built. Before this, a `parallel` branch that returned a record built outside the scope left that record frozen for the rest of the live run while a resume left it writable, so a write after the scope raised L2031 live and succeeded on resume, and an effect depending on it diverged (L5001) on the resume of unchanged source, on both engines. The copy is the value as the journal's JSON reads it back, as a thrown value's copy already was, so a `fanOut` slot whose branch answered nothing now reads `null` live, as it already did on a resume from a durable store.
