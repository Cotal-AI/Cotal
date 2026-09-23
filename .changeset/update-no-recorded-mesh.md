---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal update` and `cotal update --self` complete on a machine with no recorded mesh instead of refusing with "no mesh running": there is no running manager to observe there, so the continuity read is skipped. The same holds when every recorded mesh is down and none is selected. A recorded mesh that is down still refuses when the command selects it, with `--space` or from inside its project, and so does a named space that is not running. A connect refusal that came from mesh-target resolution now carries that target error as its `cause`.
