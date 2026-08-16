---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Add the run notice record and enforce the notify bound where the value exists.

`notify` now writes one bounded decision record per addressee onto the run — a new `notice` core
record kind, keyed `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>`. The addressee token is
derived from the agent's name rather than being it: an agent name is dotted and a dot is the
records-key separator, so a raw name would silently re-tokenize the key. The spec half is
create-only, so the retry a crash forces lands on its own record instead of filing a second notice;
the status half is the consumption, which is what the migrate rule reads to refuse moving a run
whose notice has not yet been carried by its addressee's next turn. Which turn carried it is decided
by the create-only CAS alone, so two turns racing cannot both report it as theirs.

The fact's bound is now enforced at the effect boundary, not only on literals. The validator checks
a fact written as a literal and has always said the other half out loud — a computed one is checked
where the value exists — and that is the half the bound exists for: a `detail` value assembled from
a turn result is invisible to a static check, and the rule is precisely that no interpolation hook
may launder free text into another agent's context. Over-cap is an error, never a truncation. A
length bound is also not a shape bound, so a detail value is a single line of printable text: 128
characters is ample room for a closing tag and an instruction after it.

`renderRunContext` renders the notices addressed to one agent as the fixed `<run-context>` key→value
table, and refuses — rather than escapes — a value that could end a line. A renderer that quietly
sanitized one would be the single place where the bound is a formatting convention rather than a
rule.

Notices are addressed to agent handles, which only `spawn` produces, so a durable run cannot reach
`notify` until the durable-action machinery lands. The record, the writer, the bound and the render
are proved directly; nothing here claims a durable run exercises them today.
