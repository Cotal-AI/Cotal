---
"@cotal-ai/connector-claude-code": patch
---

Wait for a forked Claude session's transcript before the first event read. Claude copies the parent
transcript into the fork's own file after its SessionStart hook, so the connector's first flush could
open a file that did not exist yet and silence the session's event plane for good. The fork path now
waits for the file with the startup path's bounded deadline and still adopts at the copied history's
end.
