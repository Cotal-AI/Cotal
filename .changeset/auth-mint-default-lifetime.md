---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal auth mint` now gives a fixed-profile credential a 24-hour lifetime by default. It used to issue one with no expiry claim, which `cotal doctor auth` then reported as a finding for good. `--expires-in` and `--expires-at` still set another lifetime. The new `--no-expiry` issues an unbounded credential and records that request beside the file, in `<file>.no-expiry.json`. `doctor auth` reports such a credential as a `CREDENTIAL_UNBOUNDED_BY_REQUEST` warning with its ways out and exits 0, while any other unbounded agent credential stays a finding. Endpoint callers (`auth mint --endpoint`) keep their behavior. A process that reads a newly minted file for more than a day, such as a dashboard given `--creds`, needs a longer lifetime or `--no-expiry`; see the upgrading guide.
