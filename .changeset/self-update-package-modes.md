---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Remove group and other write permissions from entries you own in Linux and macOS global npm `cotal-ai` package installations during `cotal update` and `cotal update --self`, with an already-current `cotal update --self` repairing modes when the registry answers, and warn instead of failing when a mode change or directory read fails on an owned entry.
