---
"@cotal-ai/cli": patch
---

The ANSI presence lines in `cotal console --plain` and `cotal join` (its presence updates and `/who`) now take their activity suffix from one `activityDetail` helper in `ui.ts`, next to `presenceDetail`. Before, each line built the dimmed ` - <activity> (set <age> ago)` inline. The output is unchanged.
