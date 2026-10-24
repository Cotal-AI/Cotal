---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/runtime": patch
---

Refusals that named no next step now carry a remedy, in the JSON envelope's `error.remedy` and under Next in the text report: an unknown or missing `config` key, a `config` value, space name or `--space` it refuses, `persona show` and `persona remove` for a persona that does not exist, `persona create` for one that does, `run validate` of a file that cannot be read, and `service show` or `service remove` of a definition that is not saved. The envelope reference now says that `remedy` is present when a refusal names a step.
