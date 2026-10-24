---
"@cotal-ai/workspace": patch
---

Only a service instance record that is not valid JSON is refused with the `mv` that moves it aside.
Any other saved record, such as a native install, uninstall or unit-action attempt or a supervisor
receipt, keeps the plain `SCHEMA_INVALID` refusal with no step, since it can be what holds a native
step back.
