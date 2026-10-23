---
"@cotal-ai/workspace": patch
---

A `preferences.json` that is a symbolic link is now refused, naming its target, as a private
record's link is. `config set` used to replace the link with a regular file while the file it named
kept the old value.
