---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
---

A launch now runs only an effort level or mode its harness lists for the model, and is refused before launch otherwise. A model catalog row can name its default variant, the harness's default model, and modes such as a fast tier, which `cotal models` prints and `cotal spawn --mode id=value` chooses. The Manager's `spawn` takes `modes` (Manager revision 55) and checks a variant or modes against the last catalog it read for that connector, reading one only when it holds none. A mode the account cannot use is listed with an `unavailable` reason, which `cotal models` prints, and a launch that names it is refused with that reason. A connector declares `supportsModes` to render them, and a resumed seat launches with the modes it was spawned with. A variant on a connector without a catalog, or on a model its catalog does not list, is now refused rather than launched at a setting the harness picks.
