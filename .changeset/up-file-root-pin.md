---
"@cotal-ai/cli": patch
---

`cotal up -f` in a folder that is already another space's root now refuses `CONFLICT`, exit 2, naming the folder's space and the manifest's, as `cotal up --space` does there. It used to drop that refusal along with the manifest errors it defers, so it exited 1 on whatever check came next, such as a broker already running at the manifest's address or a TLS flag problem.
