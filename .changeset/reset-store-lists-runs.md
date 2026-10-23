---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal reset store` now lists the workflow runs it removes. Before it stops a controller stack's live manager, `cotal down` reads the runs that manager hosts and records the unfinished ones, with the steps they wait on and their requests, in the stack journal (`operation.runs` in its JSON receipt). The reset preview, its confirmation and its receipt list those runs as of the last down (`storeContents.runsAtLastDown` and `removedRuns` in JSON), and say so when no down recorded them or the read failed. A failed read never blocks the `down`.
