---
"@cotal-ai/runtime": minor
---

Workflow commands now require a regular source file and promptly refuse devices, FIFOs and sockets with their kind named.
Symlinks to regular files still work. Pipe and process substitution inputs, including pipes with a writer, must be saved to a regular file first.
