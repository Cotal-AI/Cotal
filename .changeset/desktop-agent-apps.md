---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/pi": patch
---

The desktop app has an Agent apps screen. It lists the application each connector runs (Claude Code, Codex, OpenCode, pi, Hermes and Jcode) with its logo, version and whether it is signed in, and installs a missing one with its maker's own installer in one click, with no terminal. When an installer leaves its folder off PATH, the app adds it, and the background service picks the application up. Claude Code and Codex sign in from the app through their own browser sign-in. A connector declares all this in a new `install` field beside `requires`, which the extensions manifest caches and checks.
