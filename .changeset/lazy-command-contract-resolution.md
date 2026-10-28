---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

Endpoint calls now resolve only the command contracts they need instead of fetching the endpoint's complete visible surface. Manager operations that used to read 124 contract-store artifacts for a 40-command surface now read six artifacts for one command, while `describe` still resolves every visible command.
