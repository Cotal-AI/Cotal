---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Output redirected to a file that a file-size limit or a full disk cuts short now reports `✗ could not write to stdout` on stderr and exits 3. Before, Node's file stream counted a partial write as done, so `cotal docs cli-usage --json > report.json` under `ulimit -f 1` left 1024 bytes of invalid JSON and exited 0.
