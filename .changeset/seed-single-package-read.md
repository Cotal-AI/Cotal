---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

The seed reconcile reads a built-in's `package.json` once per check. `installedExtensionPackage` returns the installed version and declared `main` from that one read, with the error policy `installedExtensionVersion` already had, and the entry-file check takes `main` from it. The check used to parse the file a second time and treat any failure of that read as a missing entry file, so a permission error there made `cotal ext seed --repair` silently reinstall the built-in, or report a torn install while the entry file existed. A read failure now surfaces as the error it is.
