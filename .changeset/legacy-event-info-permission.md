---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Agents on older hosts keep publishing tool names and times when their credentials cannot inspect the payload stream.

Only a broker publish-permission refusal for the payload stream info request disables new payload publication. Other failures remain errors, and previously frozen payloads remain pending until their rail is available.
