---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---
Stage complete execution generations before switching the installed CLI during updates.

The updater checks the retained target before publication and keeps the original execution graph intact for running commands. Retained execution journals restore the previous selection without reinstalling the live package, while interrupted records from earlier releases keep their existing recovery path. A failed transaction restores captured connector configuration before verifying its previous execution.
