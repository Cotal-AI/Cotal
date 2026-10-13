---
"@cotal-ai/cli": patch
---

An empty `--subscribe`, `--allow-subscribe` or `--allow-publish` value on `cotal spawn`, and an empty `--allow-subscribe` or `--allow-publish` on `cotal mint`, is now an empty list. It used to read as an absent flag, so `cotal spawn <persona> --subscribe ""` launched with the persona's channels and `cotal mint <name> --allow-publish ""` granted the agent file's post list. Only an absent flag defers to the persona now.
