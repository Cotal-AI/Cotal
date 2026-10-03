---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A seat whose turn died on a harness-reported error now shows it on every operator surface. A Jcode seat relays the Harness error code, such as a provider `rate_limit`, as its presence `condition`, both for a turn the host drives and for one the TUI owns. `cotal ps` now carries that condition: the human row reads `waiting (rate_limit)` and `--json` rows include the `condition` object, alongside the roster, `cotal status` and `cotal endpoints`. The next turn clears the condition when it starts. Before, the seat read a bare `waiting` and the error was recorded only in its private connector log.
