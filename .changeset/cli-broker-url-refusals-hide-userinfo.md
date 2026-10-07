---
"@cotal-ai/cli": patch
---

A broker URL refused for embedded credentials no longer prints the URL's user part. In the NATS token form `nats://<token>@host:4222` that part is the token, so `cotal meshes add`, enrollment-bundle registration in `cotal spawn` and a manifest's `broker.servers` printed the secret they were refusing. A `broker.servers` entry that does not parse as a URL is no longer quoted either. The manifest refusals now name the entry by its position in the list.
