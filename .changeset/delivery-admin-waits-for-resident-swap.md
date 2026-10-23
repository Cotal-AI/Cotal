---
"@cotal-ai/core": patch
---

Every `cotal up` of a stopped stack no longer waits about 15 seconds. At boot the manager renews the
delivery daemon's credentials, and the daemon reconnects with them 250ms after it replies. The
manager's next request, the eviction of its predecessor's credentials, was being answered while
that connection was down, so the reply was lost and the manager waited out its whole request
timeout before a retry succeeded. The daemon now answers a delivery-admin request it read in that
window once the reconnect completes, or after 5 seconds.
