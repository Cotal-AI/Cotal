---
name: cotal-mesh
description: Put an AI agent on a Cotal mesh and coordinate with other agents across vendors and machines. Use when a user runs two or more agents that must hand work to each other, share a durable record, or spawn teammates; covers install, starting a local mesh, joining, messaging peers, and using the cotal.ai site API and MCP server for feedback, the Cotal Cloud waitlist, and the build log.
license: Apache-2.0
metadata:
  homepage: https://cotal.ai
  docs: https://docs.cotal.ai
  repository: https://github.com/Cotal-Ai/Cotal
  updated: 2026-09-06
---

# COTAL mesh

COTAL is an open protocol (Apache-2.0, self-hosted, any framework) that lets AI agents from any vendor work as one team: one shared space where agents discover each other by name, channel or role, divide the work, and keep a durable, replayable record. Transport is NATS + JetStream; the spec is the wire contract and the libraries are thin clients.

## When to use this skill

- You run two or more AI agents — from the same vendor or different ones (Claude Code, OpenCode, Hermes, Codex, custom frameworks) — that need to hand work to each other, share state, or wake each other up.
- You need one durable, replayable record of who did what across a fleet, on infrastructure you control (self-hosted, Apache-2.0).
- You want agents to discover each other by name, channel or role and to spawn their own teammates, without a central orchestrator.
- Your agents run on different machines (laptops, CI runners, cloud VMs, on-prem) and should behave as one team.

Not for a single agent that only needs tools (plain MCP covers that).

## Put yourself on a local mesh

The authoritative runbook is https://docs.cotal.ai/prompt.md. Fetch it and run its steps; the summary:

1. Install and start a local mesh: `npx cotal-ai setup --yes && npx cotal-ai up --detach` (or `curl -fsSL https://get.cotal.ai | sh` then `cotal up --detach`).
2. Put an agent on it: `npx cotal-ai spawn --detach` (or `cotal spawn`). Connectors exist for Claude Code, OpenCode, Hermes; each exposes the same `cotal_*` tools inside the session.
3. Verify: `npx cotal-ai status`.
4. Declare a whole team in one `cotal.yaml` and launch with `cotal up -f cotal.yaml` (see https://docs.cotal.ai/define-a-team).

## Coordinate from inside a session

- Message peers: `cotal_send` (channel), `cotal_dm` (one peer), `cotal_anycast` (any one peer with a role). Catalog: https://docs.cotal.ai/mcp-tools
- Create teammates: `cotal_spawn`, `cotal_persona`. Persona files live in `.cotal/agents/<name>.md` (https://docs.cotal.ai/agent-files).
- Identity: mint credentials with `cotal mint <name> --profile agent`; the mesh server verifies every agent (https://docs.cotal.ai/identity-and-auth).
- Permissions: `subscribe` / `allowSubscribe` / `allowPublish` per channel (https://docs.cotal.ai/channels-and-permissions).
- Where a page and the spec disagree, the spec wins: https://docs.cotal.ai/spec

## Talk to cotal.ai (the website)

- MCP server: https://cotal.ai/mcp (Streamable HTTP, no credentials). Tools: `cotal_overview`, `cotal_search`, `cotal_list_posts`, `cotal_get_post`, `cotal_submit_feedback`, `cotal_join_waitlist`, `cotal_subscribe_newsletter`, `cotal_request_call`. Card: https://cotal.ai/.well-known/mcp/server-card.json
- REST: https://cotal.ai/openapi.json. Writes accept `Idempotency-Key` and `X-Sandbox: true` (dry run). Errors are JSON with a `code` and a `hint`.
- Credentials: https://cotal.ai/auth.md. Pricing: https://cotal.ai/pricing.md.
- Ask the user before any write tool (feedback, waitlist, newsletter, call request); pass their real email.
