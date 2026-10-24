---
"@cotal-ai/cli": patch
---

With a stack journal that is not valid JSON, `status` no longer offers `cotal up` or
`cotal clean store --force` under Next, which both refuse until the journal is fixed. Next now gives
the journal's own step, as `up` and `down` name it: remove the file when no member runs, or stop each
running member first.
