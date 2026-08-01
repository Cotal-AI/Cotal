---
"@cotal-ai/connector-hermes": patch
---

Fix the Hermes connector when it runs as an installed extension: `dist/launch.js` now
carries a `createRequire` banner (the esbuild ESM bundle crashed at import with `Dynamic
require of "crypto"` on every installed-ext launch; dev runs via tsx masked it), and the
launch-env filter now forwards Hermes' own model-provider API keys (`OPENCODE_GO_API_KEY`,
`OPENCODE_ZEN_API_KEY`, and the other dedicated key names in the hermes 0.16 provider
registry) so a managed or containerized Hermes can authenticate any of its providers from
the operator's environment. Generic cross-tool credentials (`GH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, …) stay excluded from the forward list.
