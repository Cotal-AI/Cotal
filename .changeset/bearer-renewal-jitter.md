---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

A long-lived connection now renews its bearer at a random point between half and four fifths of the
bearer's lifetime and moves the live connection onto the new one, so the broker no longer closes it
for an expired bearer. Connections in one process and space renew at least a second apart, so seats
that started together no longer rebind through the auth callout in the same second. A reconnect
never presents an expired bearer. While renewal fails, the endpoint retries on a growing, randomized
wait of up to a minute and reports the failure once. The auth service's own connections renew the
same way, and its connect-credential reader proves a replacement on a new connection before it
switches to it, so a renewal no longer denies connects while the reader rebinds.
