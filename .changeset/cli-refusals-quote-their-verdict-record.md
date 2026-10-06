---
"@cotal-ai/cli": patch
---

The manager and delivery start refusals now quote the record their verdict was made on instead of reading the pidfile a second time. A manager or daemon removes its record when it exits, so a record that disappeared between the two reads turned the refusal and its `NEXT:` step into a bare `ENOENT`, and a record replaced in between was quoted although the verdict had read different content. This covers the delivery cutover preflight, the delivery daemon's own refusal in `cotal up`, and the manager start refusal in `cotal spawn -f`. A record that is not a pid is now reported as such, quoted on one line, in the cutover preflight and the delivery daemon refusal, which used to say the kernel had answered for a pid it was never asked about.
