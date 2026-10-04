---
"@cotal-ai/web": patch
---

`docs/watch-a-mesh.md` now quotes the all-activity deadline reason as the server builds it, `the read did not finish within <deadline>ms`, and states the 8000 ms default in its prose. The page quoted the concrete `8000ms`, which no shipped source string holds, so the docs literal gate failed on every branch.
