---
"@cotal-ai/core": patch
---

`serveControl` no longer drops a control reply that cannot be published. A reply larger than the broker's `max_payload` used to be swallowed, and the caller waited out its request timeout with nothing to tell a refused reply from a dead service. The responder now answers with `ok: false` and an error giving the reply's size in bytes and the `max_payload` refusal, and it emits `error` when that refusal cannot be published either. A handler reply that does not serialize is answered as an error the same way a throwing handler is. This affects every delivery daemon control verb, including `listMemberships`, whose reply is unbounded.
