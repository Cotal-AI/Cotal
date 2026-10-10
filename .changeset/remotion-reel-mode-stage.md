---
---

`HeaderModesReel` now frames each delivery-mode card at `MODE_STAGE`. It used to pass an 860x620 literal to `ScaleToFit` after the cards moved to an 860x780 stage, so the reel cut each card's bottom row: dave's node and label, and the subject line along the card's foot. This touches the `remotion/` asset project only; no published package changes.
