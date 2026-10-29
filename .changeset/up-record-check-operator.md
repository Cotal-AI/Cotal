---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` over a manager pidfile that holds no pid no longer tells you to remove the file once
`cotal ps` finds no manager running. A manager that does not answer on the mesh, such as a stopped
one, still runs and owns the folder while `cotal ps` finds none, and following that step started a
second manager beside it. The degraded report and its Next now ask you to confirm yourself that no
manager runs for the folder before they name `rm <pidfile>`, in the words `cotal down` uses for the
same record. `up` still refuses to start over the file, keeps the broker running, and never removes
the file itself.
