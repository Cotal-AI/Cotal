---
"@cotal-ai/manager": patch
---

`cotal supervise --space <space>` for a static space this machine hosts in another folder, run from a folder that holds no signer for it, is now refused with `PERMISSION_DENIED` before anything is written, and Next names the folder that hosts the space. It used to write a new manager instance and execution record into that folder, or into the `.cotal` of a parent folder that holds an unrelated space, and was then refused by the broker. A user-auth space was already refused this way. A bare `cotal supervise` in a folder that holds no space, with nothing selected, is now refused with `TARGET_NOT_FOUND`, and Next names `cotal supervise --space <name>` or `cotal use <name>` for a space hosted elsewhere, and `cotal up` to host one here. It used to print a timestamped line about a `main` space nobody made and exit 1.
