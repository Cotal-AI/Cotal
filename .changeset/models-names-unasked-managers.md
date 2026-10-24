---
"@cotal-ai/cli": patch
---

`cotal models` without `--on` on a space with several live managers now names the managers it did not ask, in a `Not asked` row and in `result.notAskedManagerInstanceIds`, and its Next asks each with `--on`. When the answering manager returns no catalog, the report says that manager has no agent application installed instead of only that no catalog was returned.
