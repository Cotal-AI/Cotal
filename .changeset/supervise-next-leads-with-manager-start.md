---
"@cotal-ai/manager": patch
---

A bare `cotal supervise` in a folder that holds no space, with nothing selected, is now refused in the words `cotal manager start` uses there: no space is selected, and this folder is not a space's project. Its Next now leads with `cotal manager start --space <name>` or `cotal use <name>`, which start the manager of a space a folder on this machine hosts from any folder. It keeps `cotal supervise --space <name>` for a space no folder here hosts. Next used to lead with `cotal supervise --space <name>`, which that folder refuses with `PERMISSION_DENIED` for a space another folder hosts.
