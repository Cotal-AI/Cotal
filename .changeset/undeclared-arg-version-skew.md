---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

A caller now validates a request's args in the form they are sent, so a key whose value is undefined, which JSON drops, no longer fails a responder's closed input contract. A `cotal spawn --detach` from a current CLI was refused by every manager released before `defaultAgent` existed, even with `COTAL_DEFAULT_AGENT` unset. A caller-side args refusal is now marked `not-executed`, since nothing was published. Args that JSON cannot carry, such as a BigInt, get the same `bad-request` refusal. A refusal that names a key the responder's contract does not declare carries an `ai.cotal.ep.undeclared-arg` detail. The CLI reads that detail on manager commands and reports version skew with its own version, where it used to print a bare schema error followed by a warning that the request may have run.
