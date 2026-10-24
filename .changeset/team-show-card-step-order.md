---
"@cotal-ai/cli": patch
---

`team show` after a card removal lists each card's steps in the order they were written: the delete
submission, then its outcome, with the cards in manifest order. It used to list "deleted at created
revision" before "delete submitted; outcome not implied", so a finished removal ended on a step that
read as still in flight, and a tenth card sorted before the second. The removal journal is unchanged.
