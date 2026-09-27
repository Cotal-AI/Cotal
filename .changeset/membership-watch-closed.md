---
"@cotal-ai/core": patch
"@cotal-ai/web": patch
"@cotal-ai/cli": patch
---

A membership watch that closes after setup now reaches its caller through a second callback on `watchMembership`, instead of leaving the caller holding a stale snapshot with no signal. The dashboard broadcasts the existing membership-read-failed event and the console marks the feed unreadable, instead of both keeping the last snapshot silently (#485).
