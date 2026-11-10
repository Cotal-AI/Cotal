---
"cotal-ai": patch
---

Preserve a dead daemon's socket recovery record when a startup preflight refuses, so correcting the runtime directory lets the next start recover normally. Rejected socket claims and clean shutdown still clear the record.
