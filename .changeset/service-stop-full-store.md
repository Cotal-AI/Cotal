---
"@cotal-ai/cli": patch
---

`cotal service stop stack-manager` and `cotal service restart` on a full store refuse `DEPENDENCY_UNAVAILABLE`, exit 2, before any stop is submitted, as `cotal down` does: the message names the store and its `--max-file-store` cap, and Next names `cotal history clear --space <space> --yes` and then the same command. They used to exit 3 `OPERATION_UNKNOWN` with only "insufficient resources" and no Next.
