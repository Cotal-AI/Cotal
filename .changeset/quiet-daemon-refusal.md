---
"cotal-ai": patch
---

Windows daemon restart failures now include the daemon's refusal code and message.
The restart handshake validates the response version, request ID and response shape before retaining the refusal in the command's native cause.
