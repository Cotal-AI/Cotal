---
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

Supervise of a registered remote user-auth space no longer composes or validates local trust under remote authority. A root hosting an unrelated static space's trust records beside the participant sign-in used to fail with a corrupt-bundle refusal; the manager now consults the store only for the supervised space's own records (account record, or a legacy bundle naming the space), refusing that combination of authorities while other tenants' records are never used. An unreadable record on a key that is read refuses loud with the store's own parse message.
