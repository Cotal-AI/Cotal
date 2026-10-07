---
"@cotal-ai/cli": patch
---

The `cotal status` `Web process` row and the `cotal setup` status card now read the selected mesh's dashboard from its own records: the address it recorded in `web.session` once it was listening, while the PID in its `web.pid` is alive. They used to report the dashboard up whenever anything accepted a connection on port 7799 and printed `http://cotal.localhost:7799/` regardless, so a dashboard started with `--port` read as down and an unrelated program on 7799 read as the dashboard. A `web.pid` that cannot be read is named on the row, and the rest of the output still prints.
