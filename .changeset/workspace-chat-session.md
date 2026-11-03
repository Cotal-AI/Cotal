---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Move the chat session layer from `@cotal-ai/cli` into `@cotal-ai/workspace`, exported as `@cotal-ai/workspace/chat`: the session contract, the participant engine, the native session, and the open, static and user-mode adapters. `openChatSession` admits a session through the adapter the target's recorded mode names, and a caller passes a `ControlClient` for the manager calls a static session makes at its open and its retirement, so the library never imports CLI code. `cotal chat` and `cotal channels` behave as before.
