---
"@cotal-ai/cli": patch
---

`cotal channel set`, `channel defaults` and `channel remove` warn `CHANNEL_SEED_REAPPLIES`, naming the file, when the root's default `.cotal/channels.json` sets a field they changed or names the channel they removed, because the next start of the stack writes the file's values back. The edit used to succeed with no word about the seed, and the next start undid it silently.
