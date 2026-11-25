---
"@cotal-ai/pi": minor
---

pi agents can now be launched at a chosen thinking level. `--variant <level>` renders pi's `--thinking` flag, a level that is not one of pi's own is refused before launch, and `cotal models --harness pi` lists each model's thinking levels as its variants. The model list now needs pi 0.81.0 or later; with an older pi it is unavailable and names the command pi refused.
