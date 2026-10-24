---
"@cotal-ai/workspace": patch
---

A credential file or saved private record that the shared file guard refuses with
`PERMISSION_DENIED`, because it is not an owned private regular file, is not private, or cannot be
opened without following a link, now names the file in the message and in the JSON target. Every
command that reads such a file through the guard gets this, such as `auth handle inspect`,
`feedback --key-file` and `up --manager-name`. Before, the text named no path.
