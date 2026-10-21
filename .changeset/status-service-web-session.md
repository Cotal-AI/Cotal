---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/web": patch
---

`cotal status` and `cotal status --components` read a service-run dashboard's address from its own session record. A dashboard started with `cotal service start` writes that record beside its service startup receipt and never writes `web.session`, so status found no bound address and graded a live dashboard `refused`. The holder of `web.pid` now picks the record: the web service instance whose recorded process is that PID names its own session record, and any other holder is read from `web.session`. Neither record is read in place of the other. The components row names the instance as `service instance <id>`.
