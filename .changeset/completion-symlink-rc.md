---
"@cotal-ai/cli": patch
---

`cotal completion install` with a symlinked startup file, such as a `~/.bashrc` that stow links into a dotfiles folder, now names the file, says it is a symlink and gives the line to add to the file it points to. It used to refuse with "could not be opened safely" and no path or next step. Bare `cotal completion` also warns that the file is a symlink.
