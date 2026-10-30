---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

A space's channel history now has a limit you can set. The chat stream keeps a post for 30 days, or until its sender has posted 1000 newer ones on that channel, whichever comes first, and `cotal history limit --max-age <age> --per-sender <n>` changes it for the whole space. A lower limit deletes the posts it no longer keeps, and in a terminal it asks first.

The first `cotal up` that starts an existing space's broker moves a chat stream still on the old settings (no age limit, 1000 per sender) to the new default, which deletes every channel post older than 30 days. The move runs after every other setup check, so a start that a check refuses deletes nothing, and a start that fails after the move says in its error that the limit moved. To keep posts longer, run `cotal history limit` against the running broker before it restarts; UPGRADING.md has the steps. INBOX and DLV keep their own bound of 1000 entries per subject.

`cotal history` shows the age limit and the time of the oldest post the stream still holds, and says a sender at the per-sender limit may have lost older posts there. Focus recall reports a window the stream's oldest post has passed as possibly incomplete, and its warning now also names a channel recall could not read as one possible reason. Backup restore holds the chat stream at no age through its checks, then sets the age the backup recorded.

Durable join catch-up no longer judges retention. Its per-sender check is removed because the loss it reported cannot be proven: the stream does not record which channel a removed post belonged to, so the check could refuse a join that lost nothing. Catch-up now copies the posts the stream still holds, and a post the history limit removed first is outside the durable guarantee (SPEC §4). The delivery daemon never reached that check before this release, because its read of the channel's oldest post failed.
