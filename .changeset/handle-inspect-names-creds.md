---
"@cotal-ai/auth": patch
---

`cotal auth handle inspect` on a NATS credential file now says it is a credential file and not a capability handle, which is a signed JSON grant, and that a credential file is passed with `--creds`. It said "local record input is not valid UTF-8 JSON", which was wrong for a UTF-8 file and did not say what a handle is. Neither message echoes the file.
