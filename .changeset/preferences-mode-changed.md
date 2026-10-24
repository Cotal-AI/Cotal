---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal config set` and `unset` now say when they replace a `preferences.json` whose mode was not `0600`, such as a read-only `0400`. The write still replaces it with a private `0600` file, and the receipt names the old mode in a `PREFERENCES_MODE_CHANGED` warning. It used to change the mode without a word.
