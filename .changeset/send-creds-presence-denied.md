---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal send --creds` with a credential that may not read the space's roster now refuses with `PERMISSION_DENIED` as soon as the broker denies the read. It used to wait about five seconds and report an unknown `timeout`. A batched Direct Get in core now ends on the broker's permission denial for its request.
