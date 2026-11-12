---
"@cotal-ai/cli": patch
---

Allow unattended updates on computers that have not run setup. Create missing protected config folders before the update snapshot without changing existing permissions or following symbolic links. A computer that has never had `~/.config/cotal` needs one manual `npm install -g cotal-ai@latest` to receive this fix.
