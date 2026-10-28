---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": patch
---

A conversation selection may now name channel patterns. `team.*` and `team.>` in a requested or approved selection grant every channel they match, including channels created after the approval, and the issued grant carries the pattern as it is.

Before this, `checkConversationSelection` refused any non-concrete channel. A hosted approval page that let a person grant `team.>` produced an approval every stock client then rejected, so the connection failed after the person had approved it. The grammar check is unchanged: a malformed pattern such as `team.>.x` is still refused, as are more than 32 channels. Whether the person may grant a pattern is still decided by the authority, against that person's own row.
