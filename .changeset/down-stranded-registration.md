---
"@cotal-ai/cli": patch
---

`cotal down` now stops a controller stack whose registration an older `meshes rm --force` dropped, or an older `meshes add --force` replaced with one added by hand at the stack's own root and broker. It rebuilds the registration `cotal up` writes from the stack journal, only while the stack's broker is the launch that journal records, and refuses before any member stops otherwise. A hand-added registration of another address refuses and names `cotal space forget`. Such a stack used to refuse with nothing to stop it by, or stop its manager and delivery and then refuse at the broker.
