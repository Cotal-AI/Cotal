---
"@cotal-ai/manager": patch
---

Strip every COTAL_ key from the environment the #1649 acceptance harnesses hand their children

Both acceptance harnesses spread the ambient environment into a child process. Whatever runs
them may be a managed agent session, so that spread can hand the child a live credential and a
live broker URL. `smoke:suite-ambient-env` reported both files and was red on main.

The e2e harness did strip, but from a hand-enumerated list of four keys, which only covers the
names someone thought of at the time. It now drops them by prefix, and still sets the two keys
it needs afterwards. The other harness had no strip at all and now drops them at module scope,
because a scrub inside the function that performs the spread is a promise about execution order
rather than a fact about what the child can inherit.
