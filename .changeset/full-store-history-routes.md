---
"@cotal-ai/cli": patch
---

On a full JetStream store, the refusals of `cotal down` and `cotal service stop` now say that `cotal history clear` purges all of the space's channel history, and name the route that keeps it: end the manager on the stack's host with `kill -TERM <pid>`, which stops its agents by its default policy, then run `cotal down` and `cotal up --max-file-store <bytes>` with a larger cap. The controller-root refusals of `backup create`, `backup restore`, `up --restore` and `down --preserve-state` no longer say plain `down` and `up` always keep the history; they say a full store makes `down` refuse first.
