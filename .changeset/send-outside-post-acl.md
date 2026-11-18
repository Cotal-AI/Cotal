---
"@cotal-ai/connector-core": patch
---

Refuse a `cotal_send` to a channel outside the post ACL in plain words.

On a mesh that enforces ACLs, such a post used to fail with the broker's raw `Permissions Violation for Publish to "cotal.<space>.chat.<principal>.<channel>"`. It is now refused before it reaches the broker, as `cotal_join` refuses a channel outside the read ACL: `Can't post to #lab: it's outside your post ACL (allowPublish: none). Nothing was sent.` An open mesh enforces no post ACL and is unchanged.
