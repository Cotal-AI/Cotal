---
"@cotal-ai/cli": patch
---

`cotal up` now checks a channels seed file, from `--channels` or the root's `.cotal/channels.json`, before anything starts. A channel name or value the registry would not take used to start the broker and then end as an unknown outcome with no reason, and a file that was not an object, or had a misspelled key, started with nothing seeded and no warning. Each of these now refuses with `SCHEMA_INVALID`, naming the file and the entry. The seed file format is documented under `cotal up`.
