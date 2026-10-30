---
"@cotal-ai/cli": patch
---

Show how many console roster seats the window leaves out. The roster drew whole seats around the selected one and said nothing about the rest: at 80 columns four seats showed two with no sign of the others, and the title was cut before its seat count. The title now starts with the whole seats left out above and below the window, as in `roster ↑2 ↓1 more`, so the 80-column cut keeps them. A selected seat taller than the window used to push the title out, and the title's tail then showed beside a short name row. The title now keeps its row while the box has another, and the seat shows its first rows under it. A box with one row inside gives that row to the seat's name.
