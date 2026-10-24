---
"@cotal-ai/manager": patch
---

A manager that a controller stack or `service start` runs now stops on a plain `SIGTERM`, such as
one from `kill`, a systemd stop or a system shutdown. It ignored any signal that carried no stop
request, so it kept running until `SIGKILL` and never ran its seat cleanup. It now runs the stop
with the default agent policy and exits, and the next `cotal down` records it as already gone. A
`SIGINT` without a stop request is still ignored, because Ctrl-C reaches the manager together with
the CLI that publishes the request.
