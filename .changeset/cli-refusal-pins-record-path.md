---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A manager or delivery start that refuses a record it cannot attribute now names the pidfile it read. The cutover preflight, `spawn -f`, the delivery start and `service install` used to resolve the record's spelling a second time while formatting the refusal, so a record that moved between its space-keyed and pre-upgrade names in between was misnamed, and one that appeared beside the record that was read replaced the refusal and its `NEXT:` step with an ambiguous-record error. `readProcessRecord` in `@cotal-ai/workspace` now returns the path it read on every `ProcessRecord`, and `service status --json` reports that file as `manager.path`. The config and CLI pages describe both.
