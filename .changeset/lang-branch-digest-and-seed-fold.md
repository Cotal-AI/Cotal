---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A journal seeded from the step stream now folds it, and a settled `race` binds the arms nobody walks.

**The seeding fold is a fix to a live path.** The stream is append-only: settling a step appends a
second record rather than editing the first, so a completed step is two records. A driver replays
every step record and seeds the run's journal straight from that array — and the journal folded it
halfway. Its keyed view kept the last write while its ordered view kept both, so the two disagreed
with each other on the same input: the effect ceiling counted a step once, `entries()` reported it
twice, and because both rows resolved through the keyed view, the pending row came back as a second
copy of the settled one. `orphans()` reads the ordered view, so an unconsumed step reached a
migration's orphan table twice — one decision presented to an operator as two, about a step that
happened once.

The fold keeps the FIRST occurrence of a key, not the last. That order is the order the run performed
its steps in, and a step begins when its pending row is written; keeping the last occurrence would
reorder a concurrent run's history by completion time instead, silently. A fork's plan is now
computed against the same folded view rather than against the caller's raw list, so a child's prefix
carries one row per step — it is copied to the child's stream as real records, so the doubling was
durable rather than cosmetic.

**The branch digest closes what a migration cannot see.** A migration walks a settled `race`'s
recorded winning branch and enters no other, so an edit inside a LOSING arm reached nothing that
could notice it: the plan came back identical to the plan for source that was never edited, and the
child ran. The race's scope entry now carries a digest of the losing arms' bodies, compared at the
scope's own lookup before any branch runs.

The digest is over the arms' structure with source offsets stripped, so reindenting an arm is not
editing it — a check that fires on whitespace is one people learn to route around. It covers the
losers only: the winner's arm is walked step by step and an edit there already diverges at the step
it broke, which says more than "some arm of this race changed". It is compared on resume as well as
on migration, because nothing upstream refuses edited source before a resume reaches the scope.
