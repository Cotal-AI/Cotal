---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": patch
---

Add `cotal who` and `cotal whoami`. `who` lists the live roster of the selected space with each participant's status, condition, activity, attention, harness, model and host, and whether a manager runs the seat; `--waiting` keeps rows that are waiting or report a condition and `--all` adds infrastructure endpoints. `whoami` reports the identity the CLI acts under in the selected space and what it may read, post and do, without connecting. Both write one structured document with `--json` and a plain report with `--plain`; a part they could not read makes the run `partial` (exit 4), and a roster the identity may not read is refused with `PERMISSION_DENIED`. A manager census the identity's grant does not reach, such as a user-auth user's, is labeled with a warning and leaves the run complete.

For a remote user-auth registration, a cached login remains a login even when the owner and grant cannot be derived on this machine. `whoami` reports the grant as unknown and partial, leaves the owner and principal null, and does not tell that user to sign in again. Human output labels the cached login and its advisory expiry.

`whoami` also skips dispatcher catalog refresh, so a cached login and an uncached catalog do not make this local identity read contact the IdP.

Broker addresses in identity reports and shared connection-failure messages omit URL user information, query strings and fragments. Stored connection values and connection behavior are unchanged. An unparseable address is refused by `whoami` without printing it.

Use a URL placeholder in auth-mismatch recovery instructions rather than a display address with connection data removed.
