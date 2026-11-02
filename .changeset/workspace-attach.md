---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Move terminal attach from `@cotal-ai/cli` into `@cotal-ai/workspace`, exported as `@cotal-ai/workspace/attach`: the detach key, the terminal hold, the session client over a mesh session (`attachClient`, `meshSessionTransport`), and the attach loop that establishes a session, re-establishes it when the link drops and hands back abandoned sessions (`attachSeat`, `establishAttachSession`). A caller passes a `ControlClient`, the command a seat-miss refusal names, an optional remedy for a seat with no terminal, and an optional sink for the notices the loop prints, so the library never imports CLI code. `cotal attach`, the console's attach and spawn-then-attach behave as before.
