---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

`cotal update` no longer reads a remote user mesh's manager for continuity, since that manager runs
under another install and its exchange's answer cannot change the local install; the mesh is named
and skipped, and the install proceeds. A refused remote exchange that supplies no reason now says
the face withheld it instead of presenting the HTTP status as the reason (#2158).
