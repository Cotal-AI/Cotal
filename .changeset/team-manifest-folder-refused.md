---
"@cotal-ai/cli": patch
---

`team check`, `team boot` and `team deploy` given a folder instead of a manifest file, such as
`team check .`, now refuse it as `topology view` and `up -f` do: `USAGE_INVALID`, naming the path and
that it is a directory, with the Next to name the manifest file in it. They used to give a generic
`SCHEMA_INVALID` that named no path.
