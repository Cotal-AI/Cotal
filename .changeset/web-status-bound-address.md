---
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`cotal status --components` now probes the web dashboard at the address the dashboard bound. The dashboard records its socket's host and port in `web.session` once it is listening, and status reads that record. Before, status parsed `--host` and `--port` out of the dashboard's command line and fell back to `127.0.0.1:7799`, so a port spelled any way other than plain digits (`--port 0x1f90` binds 8080) was probed at 7799, and `--port 0` was refused as an invalid port while the dashboard listened on an ephemeral one. A live dashboard pid with no readable recorded address, including a dashboard still writing its record and one started by an earlier build, is now `refused` with `no bound address recorded`.
