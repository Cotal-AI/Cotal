---
"@cotal-ai/connector-codex": patch
---

The codex-host smoke tolerates a torn JSONL tail at every poll: the two remaining direct parse chains inside `waitFor` polls now read through `readJsonLines`, which drops a partial trailing line a live child is still appending.
