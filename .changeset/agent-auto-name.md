---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
---

A new agent can now label itself from the first message it gets, using its own session's model, while it keeps its launch name as the name people mention and message. The Manager cluster advances to revision 55: `spawn` takes `autoName: true`, which reaches the seat as `COTAL_AUTO_NAME=1` (`LaunchOpts.autoName`) and is refused on a `once` spawn and on a delegated runtime. The seat's connector makes one tool-less request to its own model, outside its conversation, about the launch prompt or else the first live direct message or mention from the seat's own owner, and shows the cleaned reply as the card's `meta["ai.cotal.label"]` (`AGENT_LABEL_META_KEY`), at most 40 code points. `card.name` never changes, so mentions, direct messages and name lookups keep resolving the launch name, and readers show `meta["ai.cotal.label"] ?? name`. The card carries `meta["ai.cotal.naming"] = "pending"` until naming settles, whatever the outcome, and the label and the key's removal reach presence in one record. An owner `set-name` still changes the name, ends naming when it is out, and drops the label in the record that carries the new name. A failed naming shows no label. Claude Code, Codex and OpenCode 2.x seats have the request; Hermes, Jcode, pi and OpenCode 1.x seats show no label and never show the key. A relaunch never labels the seat again, `COTAL_DISPLAY_NAME` turns naming off, and an agent file cannot set either key. `CotalEndpoint.setCardMeta` sets or removes card meta keys in one presence record, and `setCardName` takes meta changes for the record that carries the new name.
