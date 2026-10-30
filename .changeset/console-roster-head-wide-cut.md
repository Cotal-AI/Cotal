---
"@cotal-ai/cli": patch
---

Keep a `cotal console` roster seat's head row inside its box when a wide character such as a CJK ideograph meets the cut. The row ended with that character and its `…` one cell past the content, over the right padding, so at 80 columns a seat whose activity starts with CJK painted 21 cells in a 20-cell box. The row now ends at the last whole character that leaves room for the `…`, as an ASCII row already did.
