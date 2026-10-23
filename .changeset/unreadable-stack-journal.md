---
"@cotal-ai/cli": patch
---

A stack journal left truncated or empty, as an interrupted write or a full disk can leave it, made `up`, `down` and `clean all` refuse "local record input is not valid UTF-8 JSON" with no file and no Next, `reset store` refuse with no path, and `status` report the space as prepared with no warning. Each refusal now names the journal's path and the way out: remove it when no member of the stack runs, after which `cotal up` starts the stack again, or first stop each running member with the `cotal service stop` it names. `status` warns about the journal.
