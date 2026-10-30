---
"@cotal-ai/cli": patch
---

Wrap console text by terminal columns. The feed, DM thread, detail body and roster status facts counted UTF-16 units, so CJK text made rows twice the pane width and lost the cut-off half, and an odd width split an emoji into two replacement characters. Rows now use the display width the CLI already measures elsewhere and break between grapheme clusters. ASCII wrapping is unchanged.
