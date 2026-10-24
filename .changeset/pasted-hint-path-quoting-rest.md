---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

More hints that name a path now quote it when a shell would split or expand it, so they can be pasted: the `chmod u+w` that a preferences folder, `up` and `down` name for a folder they cannot write, the home screen's `cotal up --root <dir>` row, the `cotal space create <name> --root <dir>` that `status`, an unreachable folder naming no space, and `up` for a forgotten space name, and the `cotal space create <space> --adopt --root <dir>` remedies for a moved folder.
