---
"@cotal-ai/cli": patch
---

The legacy `cotal personas show <name>`, piped or redirected, writes only the persona file, byte for byte. It used to write the file's path on a line before it, so `personas show <name> > <file>` produced a file that was not a valid persona. On a terminal it still prints the path first.
