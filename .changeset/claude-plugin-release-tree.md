---
"@cotal-ai/connector-claude-code": patch
---

The repo now carries an installable Claude Code plugin tree under `claude-plugin/`. Each release regenerates it with the built MCP and hook bundles, the `team-topology` skill, a README and the license, and stamps both plugin manifests with the release version, so an install from the repo's marketplace or from a pinned commit runs without a build and updates with each release. The marketplace at `.claude-plugin/marketplace.json` now points at that tree. Both plugin manifests also gain `homepage`, `repository`, `license` and `keywords`.
