---
"@cotal-ai/cli": patch
---

After `cotal space delete` removed a space's streams from a controller stack's running broker, `cotal up` refused until `cotal down --yes` restarted the whole stack. A bare `up` there now creates the streams again, empty, on the running broker, the way a broker start does, and starts the other members; its receipt says so, and `--json` sets `result.streamsRecreated`. It does this only when every one of the space's streams is gone. A broker that lost only some of them is left as it is, and `up` still refuses, naming the restart. The delete receipt's Next now names `cotal up` first.
