---
"@cotal-ai/cli": patch
---

A detached `up`, a bare `down` and a confirmed `history clear` interrupted by SIGINT, SIGTERM or
SIGHUP now say what they left before they exit 130, 143 or 129: the stack members still running and
the command that finishes or stops them, or which history purges were acknowledged or submitted.
They used to exit with no line about the state.
