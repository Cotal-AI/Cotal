---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`@cotal-ai/workspace/chat` now holds the rules `cotal chat` applies to a draft, so another terminal front end can follow them: typed recipients and their labels, the reply recipient, the Enter rule, how a publish outcome settles, slash commands and their outcome words, shared names, the ending notice and the close summary. `shownTime`, `concreteChannelProblem` and `offlineRecipientNotice` move to the `@cotal-ai/workspace` root. Breaking: `openChatSession` takes the front end's `words` (`ChatWords`) in place of `reopen`, so a session's refusals end with that front end's own steps; `grantRefusal` and `resolveDmTarget` take them too. `cotal chat`, `--plain` and `--stdio` print the same output as before.
