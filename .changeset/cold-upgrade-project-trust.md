---
"@cotal-ai/workspace": patch
---

Include a stopped local stack in the current project whose `stack-home.json` names this Cotal home in the one-time project trust upgrade migration, so cold upgrades after `cotal down` trust existing spaces whose `--space` name differs from the folder name while leaving cloned `.cotal` folders for other homes untrusted.
