---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`backup cleanup-fallback` and `clean restore-fallback` no longer delete files that no Cotal store
writes. When the restore's old store also holds such a file, such as a report in a custom
`--store-dir` folder or a file put into the fallback folder after the restore, the `--dry-run` names
it and the cleanup refuses `CONFLICT`, names it and deletes nothing. The cleanup now removes the old
store by its store entries, as `clean store` does, and moves the folder back if anything else is
there. A restore into the preserved store's own path, which moves that store aside whole, refuses
the same way before anything moves. Before, the cleanup deleted the whole folder with those files.
