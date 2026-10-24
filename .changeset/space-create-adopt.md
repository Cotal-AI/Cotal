---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A stopped controller project copied to another machine could never start there: `status` said to run `cotal space create <space> --root <copy>`, which refused because the folder was already the root of that space, and `up`, `down` and `clean all` said to use or move back to a folder that machine does not have. `cotal space create <space> --adopt` now takes over the copied stack journal: it rewrites it to name the new folder and the broker store under it, and records a stack that never ran there, so the next `cotal up` starts it from the copy with its store. It refuses, writing nothing, when the folder's `.cotal` is a link, when the recorded folder still holds the journal, when this machine records an instance of that stack, or when the space is prepared or registered here. Without `--adopt`, `space create` still refuses, and that refusal, `status` and the `up` refusal in a moved folder name the exact `--adopt` command.
