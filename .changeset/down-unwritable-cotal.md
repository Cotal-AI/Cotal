---
"@cotal-ai/cli": patch
---

`cotal down` on a controller stack now refuses `PERMISSION_DENIED` before the stop plan when this account cannot write the root's `.cotal`, naming the folder and the `chmod u+w` that fixes it, and stops nothing. `--dry-run` names it as a refusal the real stop would hit. It used to print the plan and then exit 3 with a raw `EACCES` on the stack journal's lock file.
