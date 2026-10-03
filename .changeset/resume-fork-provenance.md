---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-jcode": patch
---

A `--resume` seat's fork provenance is recorded on the manager. `LaunchSpec` gains `resumeRecordPath`, where a connector whose seat forks after launch has it record the source session id, the source title and a SHA-256 of the transcript it read; the Hermes and Jcode connectors declare it. The manager reads that record once the seat has written it, keeps it on the seat's resume document (an optional `resumed` field, so earlier documents still resume), and adds a `resume` object to the `ps`/`inspect` row (manager cluster revision 20). `cotal ps --wide` prints `forked from <id>` with the title and hash, and the Hermes and Jcode seats print the same facts when they fork. The Jcode fork now carries a count above 2^53 byte for byte instead of rounding it, refuses a count outside the u64 range by name, and refuses a fork record that is not an object by name.
