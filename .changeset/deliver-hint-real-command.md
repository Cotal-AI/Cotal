---
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
---

`status` no longer suggests the deprecated `cotal deliver` when the delivery responder is not bound;
it names `cotal up`. The delivery daemon's missing-credential error named `cotal go`, which does not
exist, and now says that `cotal up` mints and writes the credential.
