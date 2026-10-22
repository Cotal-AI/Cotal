---
"@cotal-ai/runtime": patch
---

`cotal run start --local`, `run resume --local` and `run revoke` given a single `--creds` file are refused as a usage error again, exit 1, with the command to run instead. Since the command-line redesign the same refusal was reported as "Outcome unconfirmed" with `OPERATION_UNKNOWN` and exit 3, although no run had been admitted and no workflow record written.
