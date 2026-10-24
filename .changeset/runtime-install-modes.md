---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Cotal's own runtime Node is usable as an executable-endpoint handler after an older installer left
its install group-writable under a umask of 0002. `cotal update`, run through the installer's
launcher, and a new run of the installer remove group and other write from the folders and files
you own in Cotal's install root, without following links. When every unsafe folder of a declared
adapter path is inside that install, the refusal says so and names `cotal update` as the fix.
