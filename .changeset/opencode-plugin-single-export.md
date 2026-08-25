---
"@cotal-ai/connector-opencode": patch
---

The published OpenCode plugin bundle exports exactly one symbol: the `cotal` plugin. OpenCode's loader treats every export of a plugin module as a plugin factory, so the log-marker constants `src/plugin.ts` exports for the smokes broke plugin loading when that file was bundled directly. The bundle now builds from a thin entry (`src/plugin.entry.ts`) that re-exports only `cotal`; the constants remain exported from the source module for the smokes.
