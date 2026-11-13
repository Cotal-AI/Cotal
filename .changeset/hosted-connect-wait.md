---
"@cotal-ai/connector-core": patch
---

A hosted `cotal_connect` holds the call open while a person decides a permission request. If they approve in that time, the call returns connected. The call asks the host again every 2 seconds and stops 25 seconds before the wait bound. After that, a later call with the same approval id waits again and does not start another request.
