---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Read installed extension metadata through one parser and pass the operation's parsed result through version checks, peer binding, entry selection and import diagnosis. Missing packages remain distinct from damaged metadata and unreadable files. A package that changes its own metadata during import no longer changes the declared peer floor used to diagnose that import.
