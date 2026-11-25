---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`service add <name>`, `service list`, and manager lifecycle commands such as `manager status` tell you to drop an unknown option instead of moving it after `--`.
