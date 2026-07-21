---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). `serverConfig` renders every space's accounts for one broker.

Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is read from each account record's authoritative `space` and validated; an unreadable record makes the guard refuse rather than undercount. `saveBrokerAuth` refuses to overwrite the broker record with a different operator (which would orphan every existing tenant's account); a system-account rotation, which keeps the operator, is still allowed.

The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory. `cotal status` reports the tenant list on a multi-space root, and target resolution fails loud with an ambiguous-target error rather than silently picking one tenant.
