---
"@cotal-ai/cli": patch
---

`cotal status` and the `cotal setup` card now share one test for whether the web extension is installed: a package in the extensions manifest that provides `web` and is on disk. A manifest entry whose package directory is gone no longer reads `installed` in status while the card reads `not installed`. A manifest or package record that cannot be read is no longer reported as not installed: status names the error on its `Web extension` row and the setup card fails with it.
