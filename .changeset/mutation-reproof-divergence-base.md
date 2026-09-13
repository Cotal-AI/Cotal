---
---

Select mutation fixtures from the commit a pull request actually diverged at. The re-proof selector diffed from a commit the head already contained, because a pull request is checked out as a merge of the base branch tip, so every commit the base gained after the fork was read as part of the change. A branch that had fallen behind therefore re-proved fixtures guarding other people's commits, spending hours to report nothing about its own files, and could be blocked by a fixture it never touched. Both selector sites now resolve the base through one shared script, the resolved base sha is printed beside the record count so a selection is auditable from a transcript, and a base that cannot be resolved fails loudly instead of quietly selecting nothing.

Refs #1582
