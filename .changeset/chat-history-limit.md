---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

A space's channel history now has a limit you can set. The chat stream keeps a post for 30 days, or until its sender has posted 1000 newer ones on that channel, whichever comes first, and `cotal history limit --max-age <age> --per-sender <n>` changes it for the whole space. A lower limit deletes the posts it no longer keeps, and in a terminal it asks first.

The first `cotal up` that starts an existing space's broker moves a chat stream still on the old settings (no age limit, 1000 per sender) to the new default, which deletes every channel post older than 30 days. To keep posts longer, run `cotal history limit` against the running broker before it restarts; UPGRADING.md has the steps. INBOX and DLV keep their own bound of 1000 entries per subject.

`cotal history` shows the age limit. Focus recall reports a window the stream's oldest post has passed as possibly incomplete. Backup restore holds the chat stream at no age through its checks, then sets the age the backup recorded. The delivery daemon's catch-up now reads a channel's oldest post through its own consumer, so a join whose window lost a sender's posts to the per-sender count is reported as not durable; the read used to fail and the join was reported complete.
