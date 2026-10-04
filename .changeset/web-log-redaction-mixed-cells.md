---
---

`smoke:web-console-auth` now sends the live launch token raw and in both mixed raw and escaped spellings to a refusing route, in the query and in the path. A redactor that matched only the whole raw token or the whole escaped token passed every earlier cell and now fails the suite.
