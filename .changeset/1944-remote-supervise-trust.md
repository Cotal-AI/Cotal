---
"@cotal-ai/manager": patch
---

Supervise of a registered remote user-auth space no longer reads the cwd root's local signing trust. A root hosting an unrelated static space's legacy trust bundle beside the participant sign-in used to fail with a corrupt-bundle refusal; the manager now skips local trust entirely under remote authority and refuses only when split trust records exist for the supervised space itself (a conflict of authorities).
