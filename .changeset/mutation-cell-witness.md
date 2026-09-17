---
---

Refuse a mutation whose named `cell` cannot observe the file the mutation edits. `expectRed` was machine-checked to redden while `cell` was only required to be present, so an entry could edit an end-to-end guard, name a parser-only cell, and grade KILLED off the collateral red. Coverage now reads what the named cell's verdict rests on and refuses one that reaches no launch, file read, or module import. A cell it cannot locate, and a suite mutating its own source, are not refused.

Refs #1545
