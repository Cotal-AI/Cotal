---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

A hosted `cotal run start` interrupted with Ctrl-C or `SIGTERM` after its request went out now says the manager may already have recorded the run, with outcome `unknown` and a pointer to `cotal run ps`, and still exits 130 or 143. Before, it exited silently while the manager went on to record the run, so a retry started a second one.
