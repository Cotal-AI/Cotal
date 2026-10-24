---
"@cotal-ai/cli": patch
---

`cotal send --to` refuses a name that no participant can carry, such as one holding `\` or longer than 128 characters, with the name rule and before any presence lookup. It used to wait out the lookup and answer `TARGET_NOT_FOUND`. A legal display name, spaces and punctuation included, is still looked up.
