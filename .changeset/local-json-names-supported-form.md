---
"@cotal-ai/runtime": patch
---

`--json` or `--plain` on `cotal run revoke`, `run check`, `run start --local` and
`run resume --local` now names a form that takes the flag, or the same command without it where
there is none, and prints no help. It used to say to use the hosted form, which revoke and check do
not have.
