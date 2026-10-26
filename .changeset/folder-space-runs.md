---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

A folder's space is the target of the commands run there only while it runs

A space `cotal space create` prepared in a folder, and one whose stack there is stopped, used to
capture every command run in that folder, overriding the space `cotal use` selected. `cotal status`
in a project whose space had never started reported that space instead of the working selection, and
`cotal ps` in a checkout whose space is stopped asked about the stopped one.

A folder's space now captures a command there only while it runs. A prepared or stopped folder space
is the target of the commands about the folder itself: `cotal up`, `cotal down`, `cotal space show`
and the folder part of `cotal status`. Every other command there targets the selection, and the line
under its `Mesh:` heading says what this folder holds and the `cotal up` that starts it. A running
folder space keeps its behaviour, including the note that the selection applies outside the folder.
