---
"@cotal-ai/web": patch
---

The web events-filter smoke's call-site cell now counts every mention of `chatOnly` in the web server and expects three, the declaration and its two calls. It used to count only `chatOnly(`, so a third call written with a space, a line break, type arguments or `?.(` left it green. No behavior changes.
