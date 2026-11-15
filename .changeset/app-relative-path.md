---
"cotal-ai": patch
---

The desktop app now leaves relative entries out of the login shell PATH when starting the background service or connecting a computer, instead of refusing the whole step. Left-out entries are named in the setup progress lines, the service receipt, the operation result, and any failure message, while `cotal daemon install` in a terminal continues to refuse relative PATH entries.
