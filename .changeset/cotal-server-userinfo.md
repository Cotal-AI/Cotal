---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

The manager refuses a `COTAL_SERVER` with a user name or password in it `USAGE_INVALID`, exit 1, before it reads, writes or dials anything, as every command refuses such a `--server`, and does not repeat the value. Before, `cotal supervise` and the manager entry printed the value, password included, in a line that blamed `--server`, or dialed it with those credentials dropped.
