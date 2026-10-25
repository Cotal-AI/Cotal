---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` in a new folder under your home folder, such as `~/Desktop/test`, now starts there. Once
`~/.cotal` existed, such a folder inherited the home's `.cotal` and `up` refused, asking for
`cotal space create <space> --root .` and then `cotal up --root .`. A bare `up` now makes the folder's
own `.cotal` and starts the stack as it does in a folder with no `.cotal` above it, and removes that
`.cotal` again when it refuses before writing anything there. When the home holds a stack an earlier
release started, that stack keeps running and keeps its records, and it still starts from the home.
`up -f` and `up --restore` there still refuse and name `space create` and an `up` from the folder.
`status --verbose` says that `up` makes the folder its own project root, and the
`--root` help says plainly that it starts the project in another folder that already has a `.cotal`.
