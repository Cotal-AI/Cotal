---
"@cotal-ai/core": minor
---

Saving an agent file no longer drops a declared-empty channel policy. `subscribe`,
`allowSubscribe` and `allowPublish` are written whenever they are set, so a file that
declares an empty read set still says so after a save. They were previously emitted only
when non-empty, which meant loading and saving a persona rewrote an explicit empty list
into an absent field and lost the difference between "reads no channels" and "never said".
Defining a persona over an existing one loads and saves its file, so that path quietly
rewrote the stored policy of an agent whose content was being edited. An unset field is
still written as unset.
