---
"@cotal-ai/auth": patch
---

`cotal service-endpoint` on a static-credential or open space now refuses `UNSUPPORTED` (exit 2),
says the space has no service endpoint host, and names a space started with
`cotal up --user-auth --service-endpoints` as what hosts one. `--json` writes the refusal envelope.
Before, every subcommand printed one bare line, exited 1 and wrote nothing under `--json`, and told
you to re-register the space with `cotal meshes add --from`. A root that does not hold the space's
user-auth service now refuses the same way and names the root that started it. `name-bind` no
longer records a request it cannot send, so it no longer offers a resend that repeats the refusal.
