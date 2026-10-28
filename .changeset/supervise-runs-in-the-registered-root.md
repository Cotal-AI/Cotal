---
"@cotal-ai/manager": patch
---

A bare `cotal supervise` for a space this machine hosts, run from a folder other than the space's root, now starts the manager in that root with its signer and instance, as `cotal manager start` does. It used to be refused with `PERMISSION_DENIED` because the folder it ran from holds no signer, after writing a new manager instance and serve identity into that folder, or into the `.cotal` of a parent folder that holds an unrelated space. With nothing selected, a bare `cotal supervise` in a folder that holds a prepared or stopped space is now refused for that space as not started, with the `cotal up` that starts it, where it used to print a log line about a `main` space nobody made.
