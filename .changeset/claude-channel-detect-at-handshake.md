---
"@cotal-ai/connector-claude-code": patch
---

The Claude connector now decides whether to push `claude/channel` wake nudges when the MCP client completes its handshake. With `COTAL_CHANNEL` unset it used to read the client's capabilities as soon as stdio was attached, before `initialize` had been read, so the capability was always empty and nudges stayed off even for a client that declares `claude/channel`. `COTAL_CHANNEL` still overrides the detection, so sessions started by the Cotal launcher, which sets it to `1`, keep their nudges on.
