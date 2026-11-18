---
"@cotal-ai/cli": patch
---

Let `cotal space forget <name>` remove a registry record that cannot be read.

One unparseable record under the mesh registry made every command refuse, `space forget` for that space included, and the refusal only said to remove the file. `space forget <name>` now removes the record whose file is named for that space, as it already did for a damaged prepared-space record, and the refusal names that command.
