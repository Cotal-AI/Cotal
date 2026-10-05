---
"@cotal-ai/web": patch
---

`cotal web --detach` on the default host and port now comes up on hosts whose system resolver has no answer for `cotal.localhost`, such as WSL2. The detached parent probed the branded `http://cotal.localhost:7799/` for readiness through Node's resolver, so every probe failed while the child was already serving on 127.0.0.1:7799; after 30 seconds it reported `web dashboard did not become HTTP-ready`, stopped the healthy child, and left only the banner in `web.log`. The readiness probe now asks the bound host and port. The printed address is unchanged.
