---
"@cotal-ai/manager": patch
"cotal-ai": patch
---

A Claude seat that your organization's managed settings stop at startup now fails with Claude's full reason, such as `disableSideloadFlags` refusing `--plugin-dir`. The manager kept only the last 160 characters of the agent's final output line, which cut off the cause that Claude prints first. It now keeps that line whole, up to 4096 characters. The Claude connector docs also describe how an administrator installs the Cotal plugin through managed settings.
