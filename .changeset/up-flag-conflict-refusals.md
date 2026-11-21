---
"@cotal-ai/cli": patch
---

`cotal up -f <file> --max-file-store`, `cotal up -f <open manifest> --rotate-sys` and `cotal up --open --rotate-sys` are now usage refusals, exit 1, with the flag to drop, instead of an unconfirmed outcome with exit 3. Nothing is started in either case.
