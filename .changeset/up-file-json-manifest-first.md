---
"@cotal-ai/cli": patch
---

`cotal up -f <manifest> --json` and `--plain` now check the manifest before refusing the flag. A
manifest that does not validate gets its own `SCHEMA_INVALID` refusal with each problem, and a valid
one is refused `UNSUPPORTED` with the remedy to omit the flag. Both used to get the controller-route
remedy, which never applies to `up -f`, and an invalid manifest's error was hidden behind it.
`define-a-team.md` now says that `cotal down` drops the space's registration.
