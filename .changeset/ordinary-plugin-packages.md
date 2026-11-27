---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/acp": minor
"@cotal-ai/linear": minor
"@cotal-ai/web": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/cmux": minor
"@cotal-ai/herdr": minor
"@cotal-ai/orca": minor
"@cotal-ai/tmux": minor
---

Cotal installs connectors and other plugins as npm packages without linking them to the CLI's copy of core.

Third-party plugins need a default registration factory and a `cotal` package declaration. Use
`cotal ext manifest` to generate the declaration and `cotal ext add <package>@latest` to install
a compatible release. ACP, Linear and the web dashboard ship with the CLI.
