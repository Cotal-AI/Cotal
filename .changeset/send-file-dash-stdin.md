---
"@cotal-ai/cli": patch
---

`cotal send --file -` now reads the message from stdin, as `--stdin` does and as `persona create --from -` already did. It was refused with `TARGET_NOT_FOUND` and "the explicit message input could not be read". A message file that cannot be read is now refused with its path, in the message and in the `--json` target.
