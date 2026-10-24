---
"@cotal-ai/cli": patch
---

A controller stack whose journal was removed, after `cotal down` had dropped its registration, started at the default address 127.0.0.1:4222 on the next bare `cotal up`, without saying so. `cotal up` now starts it at the address its saved broker definition names and warns `STACK_ADDRESS_RECOVERED`. With no saved definition either, a folder that holds the space's trust or a store from an earlier start refuses `USAGE_INVALID`, exit 1, and asks for `--server`. A freshly prepared folder still starts at the default address.
