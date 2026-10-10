---
"@cotal-ai/auth": patch
---

The auth service now builds its data account's signing context in one place. The authority plane's own mints, the remote manager credentials it issues and the delivery-admin endpoint all sign through it, where before the delivery-admin endpoint and the manager-service issue path each spelled their own copy. Credentials are unchanged.
