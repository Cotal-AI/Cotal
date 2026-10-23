---
"@cotal-ai/cli": patch
---

`cotal completion install` with a group-writable `~/.bashrc` or `~/.zshrc`, as a umask of 0002 leaves
one, now names the file, its mode and the `chmod go-w` that fixes it. It used to refuse with "shell
integration needs an owned, bounded regular file" and no path or next step. One refusal names every
unsafe startup file, stub and folder on the way to them, and nothing is created before it.
