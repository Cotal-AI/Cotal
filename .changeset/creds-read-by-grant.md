---
"@cotal-ai/cli": patch
---

`cotal send` and `cotal channel` with `--creds` now choose how to read presence and the channel registry from the credential's own grant. An agent credential from `cotal auth mint` holds no batched Direct Get row, so it watches the buckets instead, and its send is stored. It used to refuse with `PERMISSION_DENIED` on the presence read, and `channel --creds` failed on the registry read. An operator credential still reads once and leaves no consumer on the broker.
