---
"@cotal-ai/cli": patch
---

`cotal up --space <name> --server <url>` from another folder, where `<url>` is the address that space already runs on, now refuses `CONFLICT` (exit 2), saying the space runs there and naming the folder it was started in, instead of blaming "a broker not started here" and suggesting a free port that would start a second broker.
