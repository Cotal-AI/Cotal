---
"@cotal-ai/cli": patch
---

`cotal doctor auth` in the root of a space registered as open no longer reports a partial result that sends you to "run `cotal doctor auth` in a space's root folder", where it already ran. It now says the space is open and issues no credentials, so there are none to check, and exits 0 as a no-op. The open mode comes from the space's registration; missing signing trust alone is still not read as an open space.
