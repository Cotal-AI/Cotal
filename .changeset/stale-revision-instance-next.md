---
"@cotal-ai/cli": patch
---

A `service start` that selects an instance record of an earlier definition revision, as a definition
moved aside and added again leaves, still refuses `CONFLICT`, and now names that record and a Next:
`cotal service remove <name> --instance <id> --space <space> --yes`, then `start` again, after a
`service stop` of that instance when it still runs.
