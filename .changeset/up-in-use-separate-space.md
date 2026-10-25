---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A bare `cotal up` whose folder names a space that already runs from another folder
now names how to start a separate space here: its Next is `cotal up --space <name>` with a name no
other folder uses, or the `cotal down` that stops the other stack, run in that stack's folder. It
used to say only "pick a different `--space`, or `cotal down` it first".
