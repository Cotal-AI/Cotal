---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` in a new folder under your home folder, such as `~/Desktop/test`, now starts there. Once
`~/.cotal` existed, such a folder inherited the home's `.cotal` and `up` refused, asking for
`cotal space create <space> --root .` and then `cotal up --root .`. A bare `up` now makes the folder's
own `.cotal` and starts the stack as it does in a folder with no `.cotal` above it, and removes that
`.cotal` again when it refuses before writing anything there. `up -f` and `up --restore` there, and
any `up` while the home holds a stack an earlier release started, still refuse and name
`space create` and an `up` from the folder. `status --verbose` says which of the two applies, and the
`--root` help says plainly that it starts the project in another folder that already has a `.cotal`.
