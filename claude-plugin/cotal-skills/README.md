# Cotal skills for Claude Code

Agent Skills written by [Cotal](https://cotal.ai) for coordinating teams of AI agents on a Cotal
mesh. Today that is `team-topology`, which lays out a multi-agent team as an explicit topology
before anything is deployed.

The plugin carries skills only: no code, no MCP server, no hooks, and no network access.

This directory is generated at each release by `scripts/materialize-claude-plugin.mjs` from
`extensions/connector-claude-code/skills-plugin` and `implementations/cli/cotal-skills`. Edit the
sources there.

## Install

```sh
claude plugin marketplace add Cotal-AI/Cotal
claude plugin install cotal-skills@cotal-mesh --scope user
```

`cotal setup` installs it for you from the CLI's own copy.

## Support and license

Report issues at https://github.com/Cotal-AI/Cotal/issues. Apache-2.0: see `LICENSE` and `NOTICE`.
