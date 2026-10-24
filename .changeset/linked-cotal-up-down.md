---
"@cotal-ai/cli": patch
---

In a folder whose `.cotal` is a link to another folder, `cotal up` and `cotal down` exited 3 with an unconfirmed outcome ("maintenance path is not a real directory", or "refusing to delete under … it is a symlink"), and `down --yes --json` there printed a stack trace. With a `.cotal` link that leads nowhere, `up` said the folder inherits the machine's home `.cotal`. Both commands now refuse before anything reads through the link: `CONFLICT` for a link, `TARGET_NOT_FOUND` for one that leads nowhere, exit 2, naming the link, where it leads and the next step. `status` there names the same step in its `COTAL_DIR_LINKED` warning, and warns `COTAL_DIR_DANGLING` for a link that leads nowhere.
