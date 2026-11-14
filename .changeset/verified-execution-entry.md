---
"cotal-ai": patch
---

Add verified execution generations to the CLI entry without changing the update transaction.

The built-ins-only bootstrap accepts an artifact-bound descriptor, validates the retained package inventory and runs the selected generation. Fresh installations run their installed tree without copying it or writing startup state. Invalid matching descriptors refuse with reinstall guidance.
