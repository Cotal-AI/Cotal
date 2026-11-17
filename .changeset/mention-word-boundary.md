---
"@cotal-ai/core": patch
---

An `@` inside a word, such as in an email address, or right after a `/` no longer counts as a mention. Before, `mail ana@example.com` sent a mention of `example.com` and could wake an agent of that name. `mentionsIn` now starts a mention only at the start of the text or after a character that is not part of a word and is not `/`, so every surface that posts typed text follows the same rule.
