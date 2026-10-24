---
"cotal-ai": patch
---

The CLI reference now says what a settings file that does not validate does. It refuses
`SCHEMA_INVALID` on `cotal telemetry` and on every command that reports usage, and under
`DO_NOT_TRACK`, `COTAL_TELEMETRY_DISABLED` or `COTAL_TELEMETRY=off` nothing reads it, so it stops
no command.
