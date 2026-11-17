---
"@cotal-ai/pi": patch
---

A pi turn that fails now shows pi's own error in the agent's presence line, for example `Pi turn ended with error (Unknown provider: unknown) after 2 automatic continuation attempts`. Before this, the line said only that the turn ended with an error. When pi had no model provider set up, the user was told to start a new turn or replace the seat, and neither step helps. The error is put on one line and cut to 300 characters.
