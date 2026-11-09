---
"cotal-ai": patch
---

Fix start and uninstall for newly installed macOS daemons.

New LaunchAgents bind their working directory through the verified argument vector and set it before the CLI loads. Existing plists with a WorkingDirectory property keep their original native verification requirement; this does not migrate or force-remove them.
