---
"@cotal-ai/cli": patch
---

`clean store`, `clean all` and `reset store` no longer delete files that sit beside the JetStream
store. With `--store-dir` naming a folder that also held other files, `clean store --force` removed
the whole folder, and a folder holding only a planted `jetstream/` beside a note passed the store
check and went too. A store directory that holds anything besides its `jetstream` directory and
`.cotal-store-id` marker now refuses `CONFLICT` (exit 2), names those entries and removes nothing,
and a cleanup removes those two entries by name before the empty directory. `clean store` and
`clean all` take `--dry-run`, which lists what they would remove and removes nothing. `up` warns
when `--store-dir` names a folder that holds other files.
