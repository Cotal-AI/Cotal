---
"@cotal-ai/auth": patch
---

A broker error on the auth service's connect reader connection no longer denies every connect. The reader treated any async error, such as one refused publish or subscribe, as a lost connection: it stopped serving and only came back on a reconnect, which a connection that never dropped does not get, so every connect was denied with `unavailable` until the link dropped or the service restarted. The reader now goes down only when the connection is lost, and an auth error that makes the client drop the link still denies until the reconnect re-proves the reader. The service log names the broker error instead of reporting a lost connection.
