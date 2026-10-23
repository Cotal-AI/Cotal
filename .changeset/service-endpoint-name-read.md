---
"@cotal-ai/auth": patch
---

`cotal service-endpoint name <endpoint>` now prints the host's answer. Before, the client's result parser did not accept name-read results, so every run failed with "service host result: unsupported operation result", for a bound name and an unbound one alike.
