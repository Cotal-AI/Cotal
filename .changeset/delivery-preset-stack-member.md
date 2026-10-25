---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/delivery": patch
---

`cotal service start` of a `delivery` preset beside a running `stack-delivery` no longer calls the
stack's own delivery a legacy record with a Next that names nothing. Its refusal names the stack
member that runs the record, with its pid and instance, and its Next is that member's stop with
`cotal down`. After such a service takes over the delivery, `cotal status` no longer offers
`cotal up --root` first, which refused while the service ran. It first names that service's
`svc stop` with its instance, as `up`'s refusal does, then `up --root`. `status --json` carries the
services under `folder.heldServices`.
