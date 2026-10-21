---
"@cotal-ai/cli": patch
---

`cotal chat --plain` now ends on Ctrl-C, a terminate signal or a hangup, as the CLI reference says: it closes the session once and exits 130, 143 or 129. It used to stop reading input and wait without closing the session. A line typed but not ended is dropped, and a draft waiting for its `y` is reported and not sent. In the terminal view, Ctrl-C and Ctrl-D now work while the recipient picker is open: they leave, or ask first when there is a draft. The picker used to ignore them.
