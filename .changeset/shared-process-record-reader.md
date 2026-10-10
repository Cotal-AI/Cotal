---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

The manager and delivery daemon records are now read and attributed by one reader, `readProcessRecord` in `@cotal-ai/workspace`, which takes the record path and the component's attribution predicate and returns the state with the pid, content and command line behind it. The rule that a live pid is demoted to foreign only when its command line was read and is not the component's now lives in one place, and the delivery verdict keeps the command line it was decided on, as the manager's already did. No states or messages change.
