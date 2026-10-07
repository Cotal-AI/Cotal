---
"@cotal-ai/manager": patch
---

When a managed seat exits during launch or a supervised restart fails, the manager's `last output` line is now read off the seat's rendered terminal. It used to strip the escape sequences from the screen backlog and drop every non-ASCII character, so a TUI footer drawn with cursor moves between its words, such as Claude Code's `Enter to confirm · Esc to cancel`, was reported as `EntertoconfirmEsctocancel`. Words keep their spacing and separators such as `·` survive.
