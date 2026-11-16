---
"cotal-ai": patch
---

Daemon login and setup now report invalid provider URLs as usage refusals without echoing or recording the rejected URL. Validation runs before account selection or native setup effects, and help consistently describes auth URLs and discovery hostnames.
