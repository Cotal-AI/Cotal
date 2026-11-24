---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
---

A new agent can now name itself from the first message it gets, using its own session's model, and an owner rename always wins over that name. The Manager cluster advances to revision 54: `spawn` takes `autoName: true`, which reaches the seat as `COTAL_AUTO_NAME=1` (`LaunchOpts.autoName`) and is refused on a `once` spawn and on a delegated runtime. The seat's connector makes one tool-less request to its own model, outside its conversation, about the launch prompt or else the first live direct message or mention, and applies the cleaned reply through the same queue as `set-name`. The card carries `meta["ai.cotal.naming"] = "pending"` until naming settles, whatever the outcome, and a failed naming keeps the launch name. Claude Code, Codex and OpenCode 2.x seats have the request; Hermes, Jcode, pi and OpenCode 1.x seats keep their launch name and never show the key. A relaunch never names the seat again, and `COTAL_DISPLAY_NAME` turns naming off. `CotalEndpoint.setCardMeta` sets or removes one card meta key and republishes presence.
