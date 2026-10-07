---
"@cotal-ai/web": patch
---

The web dashboard now writes the `web.pid.identity` pin beside `web.pid` when it claims its pidfile, and removes both when it exits. `cotal down web` used to read every dashboard record as one that predates identity pinning: it warned that a relaunch would pin it, which no relaunch did, and signalled the recorded pid with no identity check, so after a SIGKILL left `web.pid` behind it would signal whatever process had reused that pid. A dashboard's record is now verified like the broker's and the daemons', and a reused pid is refused and preserved.
