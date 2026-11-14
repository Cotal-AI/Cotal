---
"@cotal-ai/workspace": patch
---

Count the macOS update job's two records (`update-launchd.json`, `update-launchd-result.json`) as records of the Cotal home. Under a redirected `COTAL_HOME`, `space create` and `up` now refuse to prepare a project at those paths, as they do for every other record the home holds.
