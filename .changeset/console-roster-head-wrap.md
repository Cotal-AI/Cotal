---
"@cotal-ai/cli": patch
---

Keep a console roster seat's name, activity and ages readable at every width. The seat's head was one row cut at the pane, so at a 120-column terminal a 30-character name hid its role, harness tag, activity and ages, and even a short seat lost its activity's age and `progress unknown`. The head now wraps at its piece boundaries as the status rows do: each piece starts a new row when it does not fit, so no width cuts the name or an age. The roster window counts those rows, so it draws whole seats around the selected one. A seat taller than the pane still shows only its first rows.
