---
"@cotal-ai/cli": patch
---

`cotal backup create` and `cotal up --restore` now wait up to 15 seconds for the isolated maintenance broker to report its login reload, checking that the broker is still running. They used to sleep a fixed 100 ms and read the log once, so a valid reload that logged a little later was refused with "did not confirm its maintenance-login reload". A rejected reload, a broker exit, or no result within the bound still fails the attempt.
