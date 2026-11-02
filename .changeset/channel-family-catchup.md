---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/web": minor
"@cotal-ai/workspace": minor
---

An agent can follow a channel family such as `team.>` and still get the posts it missed while away. The family holds a durable membership of its own, keyed with its final `>` stored as `=`, and each channel under it keeps its own delivery class, so the agent gets stored copies of posts on the durable channels and live delivery on the rest. It gets one copy of each post even when it also joined the channel by name. A family in an agent file's `subscribe` gets its membership at startup. The root `>` and patterns with `*` stay live only.

`cotal_join` refuses a name that is no channel name, checks a pattern against the read ACL by containment, and says whether a join keeps stored copies. `cotal_channels` lists a followed family with the state of its stored copies. When an agent's 1000 stored copies were full, its next `cotal_inbox` reply says earlier posts may have been dropped and points to `cotal history <channel>`.

An agent definition whose `subscribe` names a pattern that no single `allowSubscribe` entry contains, such as `perm.>` under `perm.*`, is now refused when it is loaded, as `cotal_join` already refused it. `cotal_persona` writes nothing the manager could not load back, which also refuses a `subscribe` channel outside `allowSubscribe`. `cotal_channels` no longer warns of a backstop on a channel read only through a pattern with `*`, shows a nested family as covered by the family above it, and shows a family the broker stopped the agent reading as no longer followed while its stored copies close. `cotal_channel_info` refuses a name that is no channel name.

`cotal channel members`, the console topology and the web graph show a family follower as a durable member of the durable channels under the family, and the removal checks in `cotal down` and `cotal team` count it on every channel under it. The graph draws those links whether the membership or the channel classes arrive first, and for a channel that appears after the page loads. The manager purges a retired agent's family row.
