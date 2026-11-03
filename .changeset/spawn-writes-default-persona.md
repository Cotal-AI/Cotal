---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A bare `cotal spawn` in this terminal whose catalog has no default persona, as a Cloud space's has before anything prepared it, now writes the shipped default persona there and launches it, instead of refusing with `TARGET_NOT_FOUND` and naming a `persona create` that rejects that same template. The write is create-only and private; an existing or edited default is launched as it stands, a named or preferred persona that is missing is still refused, and `--dry-run` writes nothing and says the launch would.
