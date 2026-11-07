---
"@cotal-ai/cli": patch
---

`cotal update` no longer reads a remote mesh's manager custody because of a `cotal supervise` process that serves another space through `COTAL_SPACE` with no `--space` argument. That read went to an unpinned manager selection and failed the reconcile whenever the owner had more than one live remote manager; the supervisor's environment now names the space it serves.
