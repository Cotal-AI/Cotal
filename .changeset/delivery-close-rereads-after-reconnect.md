---
"@cotal-ai/delivery": patch
---

A hosted delivery `close()` whose lease release is in flight while the delivery connection drops now waits for the connection to reconnect, up to the broker-gone window (`COTAL_DELIVERY_BROKER_GONE_MS`, 15 seconds by default), and repeats the release once on the reconnected connection before it decides. Before, a lease read written to the dropped socket, or buffered while it was down, timed out after 5 seconds although the broker answered again, so `close()` rejected, every later `close()` and `drain()` returned that rejection, and a successor was refused until the bucket TTL expired the row. A release that still cannot be confirmed, including one whose connection does not come back within that window, still rejects.
