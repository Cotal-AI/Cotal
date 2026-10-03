---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A seat whose turn died on a harness-reported error now shows it on every operator surface. A Jcode seat relays the Harness error code, such as a provider `rate_limit`, as its presence `condition`, both for a turn the host drives and for one the TUI owns. `cotal ps` now carries that condition: the human row reads `waiting (rate_limit)` and `--json` rows include the `condition` object, alongside the roster, `cotal status` and `cotal endpoints`. The next turn clears the condition when it starts. Before, the seat read a bare `waiting` and the error was recorded only in its private connector log.

Presence gains an optional `activeAt`: the epoch ms of the last work event the harness reported, carried on the next heartbeat. A Jcode seat records every token and tool event of its session there. `cotal ps`, `cotal status`, `cotal endpoints` and `cotal_roster` now print a condition with its age and the age of the last work event, such as `waiting (rate_limit for 40m) · active 40m ago`, and `cotal ps --json` rows carry `activeAt`. A turn that stopped advancing while its process keeps heartbeating no longer reads like one that is still working.
