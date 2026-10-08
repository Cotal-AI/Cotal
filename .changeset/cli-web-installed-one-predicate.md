---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal status` and the `cotal setup` card now share one test for whether the web extension is installed: a package in the extensions manifest that provides `web` and is on disk. A manifest entry whose package directory is gone no longer reads `installed` in status while the card reads `not installed`. A web package record that cannot be read is no longer reported as not installed: status names the error on its `Web extension` row and still prints the `Web process` row, and the setup card names it on its web row, also while the dashboard is listening. `loadExtensionsManifest` and `installedExtensionVersion` now treat only a missing file as absent, so an extensions or package directory that cannot be searched throws its permission error instead of reading as no extensions or not installed.
