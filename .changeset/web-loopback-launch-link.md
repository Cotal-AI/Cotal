---
"@cotal-ai/web": patch
---

`cotal web` on the default host and port now prints its launch link a second time at
`http://127.0.0.1:7799/`, carrying the same single-use token, so a browser or system resolver with
no answer for `cotal.localhost` (Safari, WSL2) still has a printed way in.
