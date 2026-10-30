---
"@cotal-ai/cli": patch
---

Mark every cut preview in the console's agent detail. A recent-traffic preview cut to its width cap that then fit the row showed no ellipsis, so at 80 columns a run of emoji ended after 25 with nothing to say the rest was left out, and at 47 columns a CJK preview did the same. A preview that leaves any text out now ends with `…` within the same width, and a preview that fits whole is unchanged.
