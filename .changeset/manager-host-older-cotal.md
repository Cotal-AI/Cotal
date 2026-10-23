---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A manager started by a cotal before 0.100.0 puts no host in its presence. The list of your live
managers showed its host as a bare `-` and its name as `manager`. It now reads
`not reported (started by an older cotal)` and the manager is listed by its runtime, such as `tmux`,
which `--on` also takes when only one of your managers matches it.
