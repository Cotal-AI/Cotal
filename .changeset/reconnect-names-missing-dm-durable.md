---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

An authenticated seat whose DM durable is gone after a broker outage or restore now says so. `cotal_reconnect` and the `connectionIssue` in `cotal_connection_status` name the missing durable and the recovery: restart the session, or respawn it if a manager launched it. Before, reconnect reported a bare "consumer not found" and offered retries that could never bring the durable back, and status gave no reason. The endpoint now fails that rebind with `dm-durable-missing`. Open-mesh seats still recreate their durable on reconnect.
