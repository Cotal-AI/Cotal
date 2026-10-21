---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal up` writes the authenticated broker configuration `server.conf` owner-private (0600), and creates `.cotal` and the broker store owner-private (0700), whatever the umask. Under a group-writable umask the stack's own broker preset no longer refuses the files `up` just made. The broker, auth service and delivery logs are created 0600, and the pid, identity pin and manager marker records `up` writes are created 0600. A private file written in place, through `writeSecretFile` or the new `openPrivateAppend`, is never opened through a symlink: on POSIX a symlink, a non-regular file or a file another user owns is refused with `EPERM` and left unchanged, and a file the user owns is set to 0600 through the descriptor before it is truncated or appended to. Windows keeps a mode-0600 open with no owner check, and its ACL hardening is unchanged. A refused service path now names the option, the path that failed, and its owner and mode, and a group-writable ancestor is named instead of the path below it. The text failure report shows a wrapped cause's detail as one line. The whole-stack failure hints name `cotal service --space <space>`, which lists every member with no definition name needed, in place of a bare `cotal service status`.
