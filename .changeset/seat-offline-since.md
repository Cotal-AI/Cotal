---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A managed seat that leaves the mesh while its process keeps running now says so. `cotal ps` prints how long the seat has been offline (`mesh offline for 3.5h`), and `--json` carries the seat's last presence heartbeat as `offlineSince`. The manager log gets a `seat offline on the mesh` line for each such seat and a `seat back on the mesh` line when it returns. Before this, a seat could read `running · mesh offline` for days with nothing saying when it dropped, so a watchdog that checked process liveness saw nothing wrong.
