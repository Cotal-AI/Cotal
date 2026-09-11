---
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Pin Windows teardowns to process creation time. A launch writes a sibling identity file from the UTC FILETIME of `Get-Process StartTime`, and a stop refuses when that pin no longer matches. Records with no sibling pin stay on the upgrade-only legacy path.
