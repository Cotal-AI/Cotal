---
"@cotal-ai/cli": patch
---
Keep a running command's release identity tied to the code it loaded during staged updates.

Publishing a new canonical package manifest no longer makes an older bootstrapped CLI report or reconcile as the new release. Embedded API calls retain their entry package's version and provenance.
