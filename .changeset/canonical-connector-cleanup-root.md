---
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Clean obsolete connector sets when Windows supplies a short-form profile path.

The cleanup caller resolves its existing protected version directory before passing it to the collector. Installation IDs, saved metadata and the collector's strict canonical-path requirement stay unchanged.
