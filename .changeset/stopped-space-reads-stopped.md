---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

After `cotal down`, `space`, `space show` and `use` read the space as stopped, with its last operation, such as `cotal down, completed`, as `status` does. Before, they called it prepared and not started, and `space` said no space had been started yet. `space --json` adds `state` and `lastOperation` to each prepared entry, and `use --json` adds `preparedState` and `lastOperation`.
