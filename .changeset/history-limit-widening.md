---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

`cotal history limit` now sets the limits of DMs and of the delivery daemon's inbox and stored copies as well as channel posts, and takes `none` for any age or count. `--inbox-max-age` and `--inbox-per-agent` set the inbox and stored copies together, and `--dm-max-age` and `--dm-per-sender` set DMs. A new space keeps 1000 stored copies per agent and every DM, as before, and `cotal up` and connecting never change a limit. A lower limit shows what it deletes for each agent or DM pair and asks first. With no limit flags the command prints the four streams' limits and changes nothing. Its `--json` result now lists one entry per stream under `result.streams`. Restore brings back the recorded limits of all four streams.

The delivery daemon stamps each stored copy with the count it was stored under in a `Cotal-Delivery-Limit` header, and the stored-copies notice compares against that count. A copy without the header counts as 1000.

In `@cotal-ai/core`, the chat-only limit API is replaced by one that takes the stream. `ChatHistoryLimit` becomes `HistoryLimit`, whose `perSender` is now `perSubject`; `setChatHistoryLimit`, `describeChatHistory`, `chatHistoryLimitProblem`, `chatHistoryLimitOf` and `chatHistoryRestoreStaging` become `setHistoryLimit`, `describeHistoryLimit`, `historyLimitProblem`, `historyLimitOf` and `historyLimitRestoreStaging`; and `ChatHistoryChange`, `ChatHistoryUpdateUnknown` and `ChatHistoryChanged` become `HistoryLimitChange`, `HistoryLimitUpdateUnknown` and `HistoryLimitChanged`. `isAcceptedChatHistory`, `CHAT_HISTORY_MIN_AGE_MS` and `CHAT_HISTORY_MAX_AGE_MS` are removed; `historyLimitMinAgeMs` and `HISTORY_MAX_AGE_MS` give the bounds, and `historyAgeProblem` checks an age on its own, where 0 is an age below the floor. The `stored-copies-full` event now carries the stamped `limit`.
