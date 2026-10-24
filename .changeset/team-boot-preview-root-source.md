---
"@cotal-ai/cli": patch
---

`cotal team boot <file> --dry-run` for a space with no root of its own says whose folder it read. In a
folder that belongs to another space it says so and that the apply needs a folder of its own, with
`cotal space create <space> --root <project-directory>`. In an unprepared folder it names
`cotal space create <space> --root .` with the space filled in. It labelled both folders
`invoking-folder-unprepared` and suggested `--root .` in a folder that belongs to another space.
