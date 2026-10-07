---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Every `.cotal/setup.log` entry is one timestamped line. A control character or Unicode line separator in a logged path or error message is written as a `\uXXXX` escape, so a newline in a project path can no longer split one entry into a second line that reads as an entry setup never wrote. The escaping rule is now one exported helper, `oneLine`, shared with the provenance lines. `openSetupLog` no longer takes a working directory it never read; the log always lives in the resolved project `.cotal/`.
