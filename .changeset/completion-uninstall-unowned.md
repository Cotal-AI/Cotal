---
"@cotal-ai/cli": patch
---

`cotal completion uninstall` no longer refuses when the startup folder that `ZDOTDIR` names does not exist. It removes only the recorded stub and record it finds and creates no folder, and with nothing recorded it changes nothing. A record wired into another `ZDOTDIR` is still refused with that folder named. For a stub with no ownership record, the refusal names the stub and says to delete the startup lines that source it and then delete or move the stub yourself, instead of recommending an install that refuses the same stub. Bare `cotal completion` no longer offers install or uninstall for that stub.
