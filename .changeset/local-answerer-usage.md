---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

Local workflow answers and amendments missing `--by <who>` now refuse `USAGE_INVALID` before
contacting the broker, with a JSON envelope under `--json` and a direct step naming the required
flag. Previously they reached the local handler and printed raw usage with empty JSON output.
The explicit local answerer requirement and hosted authenticated-caller attribution are unchanged.
