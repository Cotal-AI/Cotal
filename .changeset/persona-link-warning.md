---
"@cotal-ai/cli": patch
---

A persona file that is a symbolic link is now listed with a warning naming the file it links to, and
`persona show`, `edit` and `remove` name that file as the next step when they refuse the link.
