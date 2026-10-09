---
"@cotal-ai/manager": patch
---

The manager's run hosting, transcript receive, console attach endpoint, runtime artifact removal, session bridge and instance probe now take a caught value's text the way the manager itself does. A host callback, transport or runtime that rejected with `null` or `undefined` used to make the handler throw: the boot reconcile and the remote run renewal rejected with a `TypeError` (the renewal recording no debt and skipping the remaining runs), and the transcript sweep and `POST /session/<name>` ended the process with no response sent. A rejected string now keeps its text in the log line, the recorded renewal debt and the attach reply's `error` field.
