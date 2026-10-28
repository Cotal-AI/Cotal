---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

A manager or other service that `cotal manager start` or `cotal service start` launches now receives `NODE_EXTRA_CA_CERTS` from that command, as docs/cli.md tells operators of a self-signed certificate or a local CA to set it. A participant that joined such a space from its bundle could not start a manager: the native child did not trust the CA and failed with "the manager-service authority endpoint did not answer at <url> (fetch failed)". That refusal now keeps the fetch error as its cause, and the line a failing manager child logs last names it, so a TLS refusal reads through to its code, such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
