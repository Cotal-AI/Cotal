---
"@cotal-ai/connector-opencode": patch
---

Spawning OpenCode with an unsupported `opencode` on PATH now ends in one line that names the file, its version, the supported lines and how to install a supported OpenCode. It no longer prints a line of the bundled connector and a stack trace. Any other launch refusal also ends in its one-line reason.
