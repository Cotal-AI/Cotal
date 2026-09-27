---
"@cotal-ai/cli": patch
---

`--on` now refuses a malformed manager instance id at the flag with a message that names the identifier it wants and where `cotal ps` prints it, instead of the mint's bare grammar error; a roster principal id (`local.…`) is named as such (#423).
