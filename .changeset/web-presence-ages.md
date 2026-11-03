---
"@cotal-ai/core": patch
"@cotal-ai/web": patch
---

Show reported conditions and status, activity and work ages in the dashboard's roster, waiting cards and agent details, including graph details. Use core's canonical age functions through its new browser-safe presence-ages subpath, so a 90-second heartbeat displays as 1m rather than rounding to 2m. Wrap the fact lines instead of hiding them behind ellipses.
