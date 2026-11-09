---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal completion` accepts a shell startup file that your own user private group can write.

On a host whose default umask is 002, a `~/.bashrc` or `~/.zshrc` you own is left group-writable. Completion treated every group-writable file as unsafe, so `cotal completion` exited 4 and `cotal completion install` refused it while still telling you to run the install. A group-writable file or folder you own is now accepted when its group is your proven user private group and it has no extended ACL, the same rule as every other protected path. A file another account could write, a symlink, and a file you do not own are still refused. When a `chmod` fixes the file, `cotal completion` offers that `chmod` before `install`.
