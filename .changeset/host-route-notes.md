---
"@cotal-ai/auth": patch
---

A proposal read names its endpoint's binding only when that binding is the reader's own (the operator reads it as before), so an owner whose proposal sits under another owner's name no longer sees that owner's token, claim reference and request. `cotal service-endpoint approve|refuse|name-bind` prints the request id it was sent under and takes `--request-id <hex32>` to send the identical request again, which the host replays; a run without it is a new request. The docs now list the four caller-policy operations the host route serves as the owner, say that the admission operations have no engine handler yet and answer `unsupported`, and require unpredictable request ids.
