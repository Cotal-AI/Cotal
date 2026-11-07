---
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-core": patch
---

Your own Codex conversations can now join a Cotal mesh after you approve them: `cotal setup` installs a Cotal plugin into Codex, and a connected conversation is woken when messages arrive. The plugin's server binds to the conversation Codex names in each tool call's request metadata, opens and retires its identity through the existing `cotal app-identity` approval flow, queues at most one labelled notice per connection with Codex's `thread/queue/add` (the messages themselves are read with `cotal_inbox`), and publishes the conversation's own activity only from the moment of approval.
