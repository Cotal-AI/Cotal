---
"@cotal-ai/tmux": patch
---

Native attach guidance now selects the seat's window and pane using its stable pane ID.
The instructions keep reaching the seat after its pane moves or its window is renamed,
including when another pane is active in the destination window. This applies to spawned
and adopted handles.
