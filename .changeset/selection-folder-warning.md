---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A command that targets the selected space from inside a project whose root has a different
registered space now says so before it acts. It warns on stderr and in its JSON `warnings` with
`SELECTION_NOT_FOLDER_SPACE`, naming both spaces and the `--space` that targets the folder's space.
`send`, `status`, `who`, `ps`, `whoami`, `endpoints` and a named `down <service>` used to act on the
selection there with only a `Mesh:` header to show it.
